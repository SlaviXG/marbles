import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { normalizeWakeAudio } from './wakeAudio';
import { wakeMatch } from './wakePhrase';
import { WAKE_MAX_NEW_TOKENS, WAKE_MIN_RMS } from './wakeConfig';

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = new URL('/models/', self.location.href).href;
env.backends.onnx.wasm!.numThreads = self.crossOriginIsolated ? Math.min(4, self.navigator?.hardwareConcurrency || 1) : 1;
env.backends.onnx.wasm!.wasmPaths = new URL('/wake-runtime/', self.location.href).href;
let model: AutomaticSpeechRecognitionPipeline;
self.onmessage = async ({ data }: MessageEvent) => {
  try {
    if (data.type === 'load') {
      model = await pipeline<'automatic-speech-recognition'>('automatic-speech-recognition', 'wake-whisper', {
        device: 'wasm', dtype: 'q8', local_files_only: true, progress_callback: progress => {
          if (progress.status === 'progress') self.postMessage({ type: 'progress', progress: Math.round(progress.progress) });
        },
      });
      await model(new Float32Array(16_000), { return_timestamps: false, max_new_tokens: WAKE_MAX_NEW_TOKENS });
      self.postMessage({ type: 'ready' });
    } else {
      if (!(data.audio instanceof Float32Array) || !data.audio.length || !data.audio.every(Number.isFinite)) {
        self.postMessage({ type: 'result', end: data.end, length: data.length, epoch: data.epoch });
        return;
      }
      const audio = normalizeWakeAudio(data.audio);
      const started = performance.now();
      const result = await model(audio, { return_timestamps: false, max_new_tokens: WAKE_MAX_NEW_TOKENS });
      const output = Array.isArray(result) ? result[0] : result;
      const text = output.text ?? '';
      let start: number | undefined;
      if (wakeMatch(text)) {
        for (let index = 0; index < data.audio.length; index += 320) {
          const frame = data.audio.subarray(index, index + 320);
          const rms = Math.sqrt(frame.reduce((sum: number, value: number) => sum + value * value, 0) / frame.length);
          if (rms >= WAKE_MIN_RMS) { start = index / 16_000; break; }
        }
      }
      self.postMessage({ type: 'result', text, start, inferenceMs: performance.now() - started, end: data.end, length: data.length, epoch: data.epoch });
    }
  } catch (error) {
    self.postMessage({ type: 'error', phase: data.type === 'load' ? 'load' : 'inference',
      message: error instanceof Error ? error.message : String(error) });
  }
};
