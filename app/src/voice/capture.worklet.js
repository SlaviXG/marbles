// AudioContext resamples the microphone to 24 kHz. Batch messages rather than
// waking the UI for every 128-sample audio render quantum. No audio is played.
class VoiceCapture extends AudioWorkletProcessor {
  buffer = new Float32Array(2048);
  offset = 0;
  constructor() {
    super();
    this.port.onmessage = () => {
      if (this.offset) this.port.postMessage(this.buffer.slice(0, this.offset));
      this.offset = 0;
      this.port.postMessage(null); // Flush acknowledgement, ordered after audio.
    };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const sample of channel) {
        this.buffer[this.offset++] = sample;
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
