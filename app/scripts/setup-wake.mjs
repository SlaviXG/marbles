import { mkdir, readFile, writeFile, rename, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const modelRoot = path.join(appRoot, 'public/models/wake-whisper');
const runtimeRoot = path.join(appRoot, 'public/wake-runtime');
const revision = '79fb389fc764e7c395bd330e9531d9d32ada7049';
const files = [
  'config.json', 'generation_config.json', 'preprocessor_config.json',
  'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json',
  'added_tokens.json', 'normalizer.json', 'merges.txt', 'vocab.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
];

await mkdir(modelRoot, { recursive: true });
await mkdir(runtimeRoot, { recursive: true });
let manifest;
try { manifest = JSON.parse(await readFile(path.join(modelRoot, 'manifest.json'), 'utf8')); } catch {}
const sizes = {};
async function install(file) {
  const target = path.join(modelRoot, file);
  try {
    const info = await stat(target);
    if (manifest?.revision === revision && info.size > 0 && manifest.sizes?.[file] === info.size) {
      sizes[file] = info.size; return;
    }
  } catch {}
  console.log(`Installing local wake asset: ${file}`);
  const url = `https://huggingface.co/Xenova/whisper-tiny.en/resolve/${revision}/${file}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) throw new Error('Empty download');
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.partial`;
      await writeFile(temporary, bytes);
      await rename(temporary, target);
      sizes[file] = bytes.length;
      return;
    } catch (error) { lastError = error; }
  }
  throw new Error(`Could not install ${file}: ${lastError?.message}. Run npm run setup:wake when online.`);
}

// Bound concurrent downloads, especially the two ONNX model files.
for (let index = 0; index < files.length; index += 3) await Promise.all(files.slice(index, index + 3).map(install));
const require = createRequire(import.meta.url);
const ortDist = path.dirname(require.resolve('onnxruntime-web/wasm'));
for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  const target = path.join(runtimeRoot, name);
  const temporary = `${target}.${process.pid}.partial`;
  await copyFile(path.join(ortDist, name), temporary);
  await rename(temporary, target);
}
await writeFile(path.join(modelRoot, 'manifest.json'), JSON.stringify({ model: 'Xenova/whisper-tiny.en', revision, sizes }, null, 2));
console.log('Local wake model and ONNX runtime ready. Browser startup needs only localhost.');
