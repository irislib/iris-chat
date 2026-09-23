/** Unlock audio on an app gesture, then reuse it for bounded incoming rings. */
export class CallRingtone {
  private context: AudioContext | null = null
  private oscillators: OscillatorNode[] = []
  private gain: GainNode | null = null
  private timeout: ReturnType<typeof setTimeout> | undefined
  private ringing = false
  unlock = () => {
    if (typeof AudioContext === 'undefined') return
    try {
      this.context ??= new AudioContext()
      void this.context.resume().then(() => { if (this.ringing) this.play() }).catch(() => {})
    } catch { /* Audio may not be available. */ }
  }
  start() {
    if (this.ringing || typeof AudioContext === 'undefined') return
    this.ringing = true
    this.timeout = setTimeout(() => this.stop(), 30000)
    this.play()
  }
  private play() {
    if (this.oscillators.length) return
    try {
      const context = this.context ??= new AudioContext()
      if (context.state !== 'running') return
      const gain = this.gain = context.createGain()
      gain.connect(context.destination)
      const now = context.currentTime
      gain.gain.setValueAtTime(0, now)
      for (let pulse = 0; pulse < 10; pulse++) {
        const at = now + pulse * 3
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(0.035, at + 0.04)
        gain.gain.setValueAtTime(0.035, at + 0.65)
        gain.gain.linearRampToValueAtTime(0, at + 0.75)
      }
      for (const frequency of [440, 480]) {
        const oscillator = context.createOscillator()
        oscillator.frequency.value = frequency
        oscillator.connect(gain)
        oscillator.start(now)
        oscillator.stop(now + 30)
        this.oscillators.push(oscillator)
      }
    } catch { this.stop() }
  }
  stop() {
    this.ringing = false
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = undefined
    for (const oscillator of this.oscillators) {
      try { oscillator.stop(); oscillator.disconnect() } catch { /* Already stopped. */ }
    }
    this.oscillators = []
    this.gain?.disconnect(); this.gain = null
  }
  dispose() {
    this.stop()
    void this.context?.close().catch(() => {})
    this.context = null
  }
}
