// Resamples whatever the AudioContext is running at down to 16kHz mono
// PCM (s16le) and posts 40ms chunks (= 640 output samples) to the main thread.
// Naive decimation: not anti-aliased, but more than good enough for speech ASR.
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate; // input samples per output sample
    this.targetSize = 640; // 40 ms at 16 kHz
    this.outBuffer = new Float32Array(this.targetSize);
    this.outFill = 0;
    this.acc = 0; // fractional accumulator carried across process calls
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    const r = this.ratio;

    let acc = this.acc;
    for (let i = 0; i < ch.length; i++) {
      acc += 1;
      if (acc >= r) {
        acc -= r;
        this.outBuffer[this.outFill++] = ch[i];
        if (this.outFill === this.targetSize) {
          const pcm = new Int16Array(this.targetSize);
          for (let j = 0; j < this.targetSize; j++) {
            const s = Math.max(-1, Math.min(1, this.outBuffer[j]));
            pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          this.port.postMessage(pcm.buffer, [pcm.buffer]);
          this.outFill = 0;
        }
      }
    }
    this.acc = acc;
    return true;
  }
}

registerProcessor("pcm-worklet", PCMWorklet);
