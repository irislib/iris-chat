import type { CallControl } from './callProtocol'
/** Feedback describes complete frames and the highest observed frame (including loss). */
export class CallAdaptation {
  target: number
  private previousVideo?: number
  private previousFeedback?: number
  private heard: number
  private sentSinceFeedback = 0
  constructor(public cap: number, now = performance.now()) { this.target = Math.min(cap, 1_200_000); this.heard = now }
  begin(now = performance.now()) { this.heard = now }
  sentFrame() { this.sentSinceFeedback++ }
  setCap(cap: number) { this.cap = cap; this.target = Math.min(this.target, cap) }
  feedback(p: CallControl, now = performance.now()) {
    const seq = p.feedback_seq
    if (seq === undefined || (this.previousFeedback !== undefined && ((seq - this.previousFeedback) >>> 0) >= 0x80000000) || seq === this.previousFeedback) return
    this.previousFeedback = seq
    this.heard = now
    const sent = this.sentSinceFeedback
    this.sentSinceFeedback = 0
    if (p.video_seq === undefined) { if (sent > 0) this.target = this.lower(); return }
    const delta = this.previousVideo === undefined ? p.video_seq + 1 : (p.video_seq - this.previousVideo) >>> 0
    if (delta >= 0x80000000) return
    this.previousVideo = p.video_seq
    const count = p.received_frames ?? 0
    if (!delta && !count) { if (sent > 0) this.target = this.lower(); return }
    const loss = 1 - count / Math.max(delta, count)
    this.target = loss > .1 ? this.lower() : Math.min(this.cap, Math.round(this.target * 1.15 + 20000))
  }
  tick(now = performance.now()) { if (now - this.heard > 3000) { this.target = this.lower(); this.heard = now - 2001 } }
  private lower() { return Math.max(Math.min(this.cap, 100000), Math.round(this.target * .75)) }
}
