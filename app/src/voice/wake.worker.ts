import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { hasWakePhrase, wakeStart } from './wakePhrase';

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
      if (!(data.audio instanceof Float32Array) || !data.audio.length || !data.audio.every(Number.isFinite)) {
        self.postMessage({ type: 'result', end: data.end, length: data.length, epoch: data.epoch });
        return;
      }
      // Ordinary room sound needs only a phrase check. Run the more costly
      // cross-attention/timestamp alignment only for a possible wake phrase.
      const textResult = await model(data.audio, { max_new_tokens: 72 });
      const textOutput = Array.isArray(textResult) ? textResult[0] : textResult;
      if (!hasWakePhrase(textOutput.text)) {
        self.postMessage({ type: 'result', end: data.end, length: data.length, epoch: data.epoch });
        return;
      }
      const result = await model(data.audio, { return_timestamps: 'word', max_new_tokens: 72 });
      const output = Array.isArray(result) ? result[0] : result;
      self.postMessage({ type: 'result', start: wakeStart(output.chunks ?? []), end: data.end, length: data.length, epoch: data.epoch });
    }
  } catch (error) {
    self.postMessage({ type: 'error', phase: data.type === 'load' ? 'load' : 'inference',
      message: error instanceof Error ? error.message : String(error) });
  }
};
