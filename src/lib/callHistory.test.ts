import { describe, expect, it } from 'vitest'
import { callHistoryFromState, callHistoryLabel, formatCallDuration, restoredCallHistory } from './callHistory'
import type { CallState } from './callSession'

const state: CallState = {
  id: 'ab'.repeat(16), owner: 'person', peers: ['device'], direction: 'incoming',
  status: 'ended', video: true, muted: false, camera: true, remoteMuted: false,
  remoteVideo: true, started: 10_000, endedAt: 50_000, receivedAudio: 0, receivedVideo: 0,
}

describe('call history', () => {
  it('distinguishes missed, canceled, declined and media-ready answered calls', () => {
    expect(callHistoryFromState(state)).toMatchObject({ outcome: 'missed', durationSeconds: 0 })
    expect(callHistoryFromState({ ...state, direction: 'outgoing' }).outcome).toBe('canceled')
    expect(callHistoryFromState({ ...state, outcome: 'declined' }).outcome).toBe('declined')
    const answered = callHistoryFromState({ ...state, video: false, connected: 18_000 })
    expect(answered).toMatchObject({ outcome: 'answered', video: false, answeredAt: 18_000, durationSeconds: 32 })
    expect(callHistoryLabel(answered)).toBe('Incoming voice call')
    const elsewhere = callHistoryFromState({ ...state, connected: 18_000, outcome: 'answered_elsewhere' })
    expect(elsewhere).toMatchObject({ outcome: 'answered_elsewhere', durationSeconds: 0 })
    expect(elsewhere.answeredAt).toBeUndefined()
    expect(callHistoryLabel(elsewhere)).toBe('Answered on another device')
  })
  it('restores interrupted calls without counting time spent away as talking', () => {
    const ringing = callHistoryFromState({ ...state, status: 'ringing', endedAt: undefined })
    expect(ringing.inProgress).toBe(true)
    expect(callHistoryLabel(ringing)).toBe('Incoming video call')
    const restored = restoredCallHistory(structuredClone(ringing))
    expect(restored.content).toBe('Missed video call')
    expect(restored.call).toMatchObject({ endedAt: 10_000, durationSeconds: 0 })
    expect(restored.call?.inProgress).toBeUndefined()
    const active = callHistoryFromState({ ...state, status: 'active', connected: 18_000, endedAt: undefined })
    expect(restoredCallHistory(active).call).toMatchObject({ outcome: 'answered', endedAt: 18_000, durationSeconds: 0 })
  })
  it('formats short and long call durations', () => {
    expect(formatCallDuration(0)).toBe('0:00')
    expect(formatCallDuration(75)).toBe('1:15')
    expect(formatCallDuration(3723)).toBe('1:02:03')
  })
})
