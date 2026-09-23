/** A quiet, bounded incoming ring. Suspended browser audio is left suspended. */
export class CallRingtone {
  private context: AudioContext | null = null
  private timeout: ReturnType<typeof setTimeout> | undefined
  start() {
    if (this.context || typeof AudioContext === 'undefined') return
    try {
      const context = new AudioContext()
      if (context.state !== 'running') { void context.close().catch(() => {}); return }
      this.context = context
      const gain = context.createGain()
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
      }
      this.timeout = setTimeout(() => this.stop(), 30000)
    } catch { this.stop() }
  }
  stop() {
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = undefined
    void this.context?.close().catch(() => {})
    this.context = null
  }
}
