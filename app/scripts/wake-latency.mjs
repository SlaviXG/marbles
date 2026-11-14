import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { env, pipeline } from '@huggingface/transformers';

// Offline replay of the HEAD WakeDetector scheduling rules and the new hop/VAD
// rules. Decodes use the installed model; logical completion time includes each
// measured inference duration, while audio arrives every 100 ms.
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = new URL('../public/models/', import.meta.url).pathname;
const model = await pipeline('automatic-speech-recognition', 'wake-whisper', { device: 'cpu', dtype: 'q8', local_files_only: true });

function wav(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error('Expected RIFF WAV');
  let rate, channels, bits, offset, size;
  for (let pos = 12; pos + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', pos, pos + 4), length = data.getUint32(pos + 4, true);
    if (name === 'fmt ') { channels = data.getUint16(pos + 10, true); rate = data.getUint32(pos + 12, true); bits = data.getUint16(pos + 22, true); }
    if (name === 'data') { offset = pos + 8; size = length; break; }
    pos += 8 + length + (length % 2);
  }
  if (rate !== 24000 || channels !== 1 || bits !== 16 || offset == null) throw Error(`Expected 24 kHz mono PCM16; got ${rate} Hz, ${channels} channel(s), ${bits} bits`);
  return Float32Array.from({ length: size / 2 }, (_, i) => data.getInt16(offset + i * 2, true) / 32768);
}
function downsample(audio) {
  const result = new Float32Array(Math.floor(audio.length * 2 / 3));
  for (let i = 0; i < result.length; i++) {
    const start = i * 1.5, end = start + 1.5;
    let sum = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) sum += audio[j] * (Math.min(end, j + 1) - Math.max(start, j));
    result[i] = sum / 1.5;
  }
  return result;
}
function normalize(audio) {
  let peak = 0; for (const value of audio) peak = Math.max(peak, Math.abs(value));
  const gain = peak ? Math.max(1, Math.min(8, 0.25 / peak)) : 1;
  return audio.map(value => Math.max(-1, Math.min(1, value * gain)));
}
function oldMatch(text) {
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let row = Array.from({ length: 8 }, (_, i) => i);
    for (let i = 1; i <= word.length; i++) {
      const next = [i];
      for (let j = 1; j <= 7; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(word[i - 1] !== 'marbles'[j - 1]));
      row = next;
    }
    if (word.length >= 3 && word.length <= 14 && 1 - row[7] / Math.max(word.length, 7) >= 0.5) return true;
  }
  return false;
}
function newMatch(text) {
  return /\b(?:marbles|marble|marbels|marbel|marvels|marvel|mabels|mables|marbos|marbleous|mar\s+bles)\b/i.test(text) || /\bhey(?:marbles|marble|marbels)\b/i.test(text);
}
async function replay(clip, kind) {
  const rate = 24000, step = 2400;
  let clipOnset = 0;
  for (let i = 0; i < clip.length; i += step) {
    const chunk = clip.subarray(i, i + step);
    const rms = Math.sqrt(chunk.reduce((sum, value) => sum + value * value, 0) / chunk.length);
    if (rms >= .004) { clipOnset = i / rate * 1000; break; }
  }
  const stream = new Float32Array(rate + clip.length + rate);
  stream.set(clip, rate);
  let total = 0, lastVoiceEnd = 0, lastJobEnd = 0, lastJobVoiceEnd = 0, sinceJob = 0, lastScheduled = 0, finalScheduled = false;
  let noise = .001, onset = 0, busy = false, pending, complete, detected, matched = '', dropped = 0;
  const inferences = [];
  const schedule = (end) => {
    const length = Math.min(end, rate * (kind === 'old' ? 4 : 1.5));
    const job = { end, length, samples: downsample(stream.slice(end - length, end)) };
    if (busy) { if (pending) dropped++; pending = job; } else ready.push(job);
  };
  const ready = [];
  for (let tick = 0; tick <= stream.length / step + 20 && detected == null; tick++) {
    const now = tick * 100;
    if (complete && complete.at <= now) {
      busy = false;
      if (complete.match) { detected = complete.at; matched = complete.text; break; }
      complete = undefined;
      if (kind === 'old') {
        const end = Math.min(total, lastVoiceEnd + rate * .3);
        if (lastVoiceEnd && end > lastJobEnd && (lastVoiceEnd > lastJobVoiceEnd || end - lastJobEnd >= rate * .2) && sinceJob >= rate * .65 && total >= rate) {
          lastJobEnd = end; lastJobVoiceEnd = lastVoiceEnd; sinceJob = 0; schedule(end);
        }
      } else if (pending) { ready.push(pending); pending = undefined; }
    }
    if (tick * step < stream.length) {
      const chunk = stream.subarray(tick * step, Math.min(stream.length, (tick + 1) * step));
      total += chunk.length; sinceJob += chunk.length;
      const rms = Math.sqrt(chunk.reduce((sum, value) => sum + value * value, 0) / chunk.length);
      if (kind === 'old') {
        if (rms >= .0015) lastVoiceEnd = total;
        if (!busy && total >= rate && sinceJob >= rate * .65 && lastVoiceEnd) {
          const end = Math.min(total, lastVoiceEnd + rate * .3);
          if (end > lastJobEnd && (lastVoiceEnd > lastJobVoiceEnd || end - lastJobEnd >= rate * .2)) {
            lastJobEnd = end; lastJobVoiceEnd = lastVoiceEnd; sinceJob = 0; schedule(end);
          }
        }
      } else {
        const voiced = rms >= Math.max(.004, noise * 2.5);
        if (voiced) { if (!lastVoiceEnd || total - chunk.length - lastVoiceEnd > rate * .35) { onset = total - chunk.length; finalScheduled = false; lastScheduled = 0; } lastVoiceEnd = total; }
        else noise += (Math.min(rms, noise * 1.5) - noise) * .04;
        if (lastVoiceEnd && voiced && (!lastScheduled || total - lastScheduled >= rate * .25)) { schedule(total); lastScheduled = total; }
        if (lastVoiceEnd && !finalScheduled && total - lastVoiceEnd >= rate * .25) { schedule(lastVoiceEnd + rate * .25); finalScheduled = true; }
      }
    }
    if (!busy && ready.length) {
      const job = ready.shift(); busy = true;
      const start = performance.now();
      const result = await model(normalize(job.samples), { return_timestamps: kind === 'old', max_new_tokens: kind === 'old' ? 72 : 12 });
      const duration = performance.now() - start;
      const text = (Array.isArray(result) ? result[0] : result).text ?? '';
      inferences.push({ at: now, ms: Math.round(duration), text: text.trim() });
      complete = { at: now + duration, match: (kind === 'old' ? oldMatch : newMatch)(text), text };
    }
  }
  return { detected: detected != null, text: matched.trim(), latencyMs: detected == null ? null : Math.round(detected - 1000 - clipOnset), inferences, dropped };
}

await model(new Float32Array(16000), { return_timestamps: false, max_new_tokens: 12 });
const paths = process.argv.slice(2);
let boundaryBenchmarked = false;
for (const path of paths.length ? paths : ['/tmp/wake-Marbles.wav', '/tmp/wake-HeyMarbleswhatisCode.wav']) {
  const clip = wav(await readFile(path));
  if (!boundaryBenchmarked) {
    const short = normalize(downsample(clip.slice(0, 24000 * 1.5)));
    const timings = {};
    let started = performance.now();
    await model(short, { return_timestamps: false, max_new_tokens: 12 });
    timings.fastPass = Math.round(performance.now() - started);
    started = performance.now();
    for (let i = 0; i < short.length; i += 320) {
      const frame = short.subarray(i, i + 320);
      if (Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length) >= .004) break;
    }
    timings.energyOnsetExtra = Math.round((performance.now() - started) * 1000) / 1000;
    started = performance.now();
    await model(short, { return_timestamps: true, max_new_tokens: 12 });
    timings.timestampRedecodeExtra = Math.round(performance.now() - started);
    console.log(JSON.stringify({ boundaryMethodMs: timings }));
    boundaryBenchmarked = true;
  }
  console.log(JSON.stringify({ clip: path, old: await replay(clip, 'old'), new: await replay(clip, 'new') }, null, 2));
}
