/** Fixed-size PCM capture and bounded playback run on the audio rendering thread. */
export const callAudioWorklet = `
class CallAudio extends AudioWorkletProcessor {
  constructor() {
    super(); this.capture = new Float32Array(960); this.captureIndex = 0;
    this.captured = []; this.capturePending = false; this.rendered = 0;
    this.playoutPending = false; this.playoutAt = undefined;
    this.queue = []; this.offset = 0; this.queued = 0; this.started = false; this.active = false;
    this.port.onmessage = event => {
      if (event.data.active !== undefined && this.active !== event.data.active) {
        this.active = event.data.active; this.captureIndex = 0; this.captured = [];
      }
      if (event.data.captured) { this.capturePending = false; this.sendCapture(); }
      if (event.data.played) { this.playoutPending = false; this.requestPlayout(); }
      if (event.data.pcm) {
        const pcm = event.data.pcm; this.queue.push(pcm); this.queued += pcm.length;
        while (this.queued > 9600 && this.queue.length > 1) { this.queued -= this.queue.shift().length - this.offset; this.offset = 0; }
      }
    };
  }
  sendCapture() {
    if (this.capturePending || !this.captured.length) return;
    const frame = this.captured.shift(); this.capturePending = true;
    this.port.postMessage(frame, [frame.pcm.buffer]);
  }
  requestPlayout() {
    if (this.playoutPending || this.playoutAt === undefined) return;
    this.playoutPending = true;
    this.port.postMessage({ playout: this.playoutAt }); this.playoutAt = undefined;
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input && this.active) for (let i = 0; i < input.length; i++) {
      this.capture[this.captureIndex++] = input[i];
      if (this.captureIndex === 960) {
        this.captured.push({ pcm: this.capture, capturedAt: currentTime + (i + 1 - 960) / sampleRate });
        // Keep one transfer in flight and at most three recent complete frames.
        if (this.captured.length > 3) this.captured.shift();
        this.capture = new Float32Array(960); this.captureIndex = 0; this.sendCapture();
      }
    }
    const output = outputs[0]?.[0];
    if (output) {
      if (!this.started && this.queued >= 960) this.started = true;
      for (let i = 0; i < output.length; i++) {
        if (this.started && this.queue.length) {
          output[i] = this.queue[0][this.offset++]; this.queued--;
          if (this.offset === this.queue[0].length) { this.queue.shift(); this.offset = 0; }
        } else { output[i] = 0; this.started = false; }
        if (++this.rendered === 960) {
          this.rendered = 0;
          // Coalesce requests if the main thread stalls; old device deadlines
          // must not accumulate into a burst of obsolete decoding work.
          this.playoutAt = currentTime + (i + 1) / sampleRate; this.requestPlayout();
        }
      }
    }
    return true;
  }
}
registerProcessor('iris-call-audio', CallAudio);
`
