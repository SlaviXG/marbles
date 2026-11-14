import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { normalizeWakeAudio, recognizedWakeStart } from './wakeAudio';

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = new URL('/models/', self.location.href).href;
env.backends.onnx.wasm!.numThreads = 1;
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
      self.postMessage({ type: 'ready' });
    } else {
      if (!(data.audio instanceof Float32Array) || !data.audio.length || !data.audio.every(Number.isFinite)) {
        self.postMessage({ type: 'result', end: data.end, length: data.length, epoch: data.epoch });
        return;
      }
      // Decode once with segment timestamps. A second word-alignment decode
      // used to delay activation and could disagree with an initial match.
      const audio = normalizeWakeAudio(data.audio);
      const result = await model(audio, { return_timestamps: true, max_new_tokens: 72 });
      const output = Array.isArray(result) ? result[0] : result;
      self.postMessage({ type: 'result', start: recognizedWakeStart(output, data.audio), end: data.end, length: data.length, epoch: data.epoch });
    }
  } catch (error) {
    self.postMessage({ type: 'error', phase: data.type === 'load' ? 'load' : 'inference',
      message: error instanceof Error ? error.message : String(error) });
  }
};
