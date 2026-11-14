import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { wakeStart } from './wakePhrase';

env.allowLocalModels = false;
env.backends.onnx.wasm!.numThreads = 1;
let model: AutomaticSpeechRecognitionPipeline;
self.onmessage = async ({ data }: MessageEvent) => {
  try {
    if (data.type === 'load') {
      model = await pipeline<'automatic-speech-recognition'>('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
        device: 'wasm', dtype: 'q8', progress_callback: progress => {
          if (progress.status === 'progress') self.postMessage({ type: 'progress', progress: Math.round(progress.progress) });
        },
      });
      self.postMessage({ type: 'ready' });
    } else {
      const result = await model(data.audio, { return_timestamps: 'word', max_new_tokens: 72 });
      const output = Array.isArray(result) ? result[0] : result;
      self.postMessage({ type: 'result', start: wakeStart(output.chunks ?? []), end: data.end, length: data.length, epoch: data.epoch });
    }
  } catch (error) { self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
};
