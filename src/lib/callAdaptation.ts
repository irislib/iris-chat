import type { CallControl } from './callProtocol'
/** Feedback describes complete frames and the highest observed frame (including loss). */
export class CallAdaptation {
  target: number
  private previousVideo?: number
  private previousFeedback?: number
  private heard: number
  private sentSinceFeedback = 0
  private healthyMs = 5000
  private frameDebt = 0
  constructor(public cap: number, now = performance.now()) { this.target = Math.min(cap, 1_200_000); this.heard = now }
  begin(now = performance.now()) { this.heard = now }
  sentFrame() { this.sentSinceFeedback++ }
  setCap(cap: number) { this.cap = cap; this.target = Math.min(this.target, cap) }
  feedback(p: CallControl, now = performance.now()) {
    const seq = p.feedback_seq
    const count = p.received_frames, bytes = p.received_bytes, interval = p.interval_ms
    if (seq === undefined || count === undefined || bytes === undefined || interval === undefined ||
      ![seq, count, bytes, interval].every(value => Number.isInteger(value) && value >= 0) ||
      seq > 0xffffffff || count > 300 || bytes > 10_000_000 || interval < 200 || interval > 5000 ||
      (p.video_seq !== undefined && (!Number.isInteger(p.video_seq) || p.video_seq < 0 || p.video_seq > 0xffffffff)) ||
      (this.previousFeedback !== undefined && ((seq - this.previousFeedback) >>> 0) >= 0x80000000) || seq === this.previousFeedback) return
    const delta = p.video_seq === undefined ? 0 : this.previousVideo === undefined ? (p.video_seq + 1) >>> 0 : (p.video_seq - this.previousVideo) >>> 0
    if (delta >= 0x80000000) return
    this.previousFeedback = seq
    this.heard = now
    const sent = this.sentSinceFeedback
    this.sentSinceFeedback = 0
    this.previousVideo = p.video_seq ?? this.previousVideo
    const expected = count === 0 ? Math.max(delta, sent) : delta
    this.frameDebt = Math.max(0, Math.min(1000, this.frameDebt + Math.min(1000, expected) - count))
    if (!expected) return
    const loss = Math.max(0, this.frameDebt - 1) / Math.max(expected, count)
    if (loss > .02 || count === 0) {
      this.healthyMs = 0
      this.frameDebt = 0
      this.target = Math.max(Math.min(this.cap, 100000), Math.floor(count === 0 ? this.target / 2 : Math.min(this.target * .75, bytes * 8000 / interval * .85)))
    } else {
      this.healthyMs = Math.min(5000, this.healthyMs + interval)
      if (this.healthyMs >= 5000) this.target = Math.min(this.cap, this.target + Math.floor((this.target * .08 + 10000) * interval / 1000))
    }
  }
  tick(now = performance.now()) { if (now - this.heard > 3000) { this.healthyMs = 0; this.target = this.lower(); this.heard = now - 2001 } }
  private lower() { return Math.max(Math.min(this.cap, 100000), Math.round(this.target * .75)) }
}
