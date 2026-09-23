/** Fixed-size PCM capture and bounded playback run on the audio rendering thread. */
export const callAudioWorklet = `
class CallAudio extends AudioWorkletProcessor {
  constructor() {
    super(); this.capture = new Float32Array(960); this.captureIndex = 0;
    this.queue = []; this.offset = 0; this.queued = 0; this.started = false; this.active = false;
    this.port.onmessage = event => {
      if (event.data.active !== undefined && this.active !== event.data.active) { this.active = event.data.active; this.captureIndex = 0; }
      if (event.data.pcm) {
        const pcm = event.data.pcm; this.queue.push(pcm); this.queued += pcm.length;
        while (this.queued > 9600 && this.queue.length > 1) { this.queued -= this.queue.shift().length - this.offset; this.offset = 0; }
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input && this.active) for (const sample of input) {
      this.capture[this.captureIndex++] = sample;
      if (this.captureIndex === 960) { this.port.postMessage({ pcm: this.capture }, [this.capture.buffer]); this.capture = new Float32Array(960); this.captureIndex = 0; }
    }
    const output = outputs[0]?.[0];
    if (output) {
      if (!this.started && this.queued >= 960) this.started = true;
      for (let i = 0; i < output.length; i++) {
        if (this.started && this.queue.length) {
          output[i] = this.queue[0][this.offset++]; this.queued--;
          if (this.offset === this.queue[0].length) { this.queue.shift(); this.offset = 0; }
        } else { output[i] = 0; this.started = false; }
      }
    }
    return true;
  }
}
registerProcessor('iris-call-audio', CallAudio);
`
