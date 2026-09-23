import type { CallState } from './callSession'

export type CallOutcome = 'missed' | 'answered' | 'canceled' | 'declined'
export interface CallHistory {
  callId: string
  direction: 'incoming' | 'outgoing'
  outcome: CallOutcome
  video: boolean
  startedAt: number
  answeredAt?: number
  endedAt: number
  durationSeconds: number
  inProgress?: boolean
}

export function callHistoryFromState(state: CallState): CallHistory {
  const answered = state.connected !== undefined
  const endedAt = state.endedAt ?? state.connected ?? state.started
  return {
    callId: state.id,
    direction: state.direction,
    outcome: answered ? 'answered' : state.outcome ?? (state.direction === 'incoming' ? 'missed' : 'canceled'),
    video: state.video,
    startedAt: state.started,
    ...(answered && { answeredAt: state.connected }),
    endedAt,
    durationSeconds: answered ? Math.max(0, Math.floor((endedAt - state.connected!) / 1000)) : 0,
    ...(state.status !== 'ended' && { inProgress: true }),
  }
}

export function callHistoryLabel(call: CallHistory): string {
  const kind = call.video ? 'video call' : 'voice call'
  const prefix = call.inProgress || call.outcome === 'answered'
    ? (call.direction === 'incoming' ? 'Incoming' : 'Outgoing')
    : ({ missed: 'Missed', canceled: 'Canceled', declined: 'Declined' } as const)[call.outcome]
  return `${prefix} ${kind}`
}

export function formatCallDuration(seconds: number): string {
  const duration = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(duration / 60)
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(duration % 60).padStart(2, '0')}`
    : `${minutes}:${String(duration % 60).padStart(2, '0')}`
}

// A restored app has no live media engine. Keep the last observed time rather
// than counting time after a crash or reload as time spent talking.
export function restoredCallHistory(call?: CallHistory): { call?: CallHistory; content?: string } {
  if (!call) return {}
  const { inProgress: _inProgress, ...finished } = call
  return { call: finished, content: callHistoryLabel(finished) }
}
