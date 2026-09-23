import { get, writable } from 'svelte/store'
import type { FipsNode } from '@fips/core'
import { chats, recordCallHistory } from './chat'
import { callHistoryFromState } from './callHistory'
import { getNdrRuntime, preparePeerNdrRuntime } from './privateChats'
import { getMessageRequestPolicyContext, isChatAccepted, isChatRejected } from './messageRequestPolicy'
import { callSettings } from './callSettings'
import { CallSession, type CallState } from './callSession'
import { BrowserCallMedia, type CallMediaStats } from './callMedia'
import { CallRingtone } from './callRingtone'
const ringtone = new CallRingtone()

export const callState = writable<CallState | null>(null)
export const callError = writable('')
export const callMediaStats = writable<CallMediaStats | null>(null)
export const localCallStream = writable<MediaStream | null>(null)
export const remoteCallVideo = writable<HTMLCanvasElement | null>(null)
let session: CallSession | null = null
let runtimeCleanup: (() => void) | undefined
let connectedPeers: () => string[] = () => []
let connectCallPeers: ((owner: string) => Promise<void>) | undefined
let starting = false
const answersInFlight = new Set<string>()
let media: BrowserCallMedia | null = null
let generation = 0

export function callOwnerForPeer(peer: string): string | undefined {
  if (!/^(02|03)[0-9a-f]{64}$/.test(peer)) return
  const context = getMessageRequestPolicyContext()
  try {
    const snapshot = getNdrRuntime().getKnownAppKeysSnapshots().find(s => s.appKeys.getAllDevices().some(d => d.identityPubkey.toLowerCase() === peer.slice(2)))
    if (!snapshot || snapshot.ownerPubkey === context.myPubkey || isChatRejected(snapshot.ownerPubkey, context)) return
    const chat = Array.from(get(chats).values()).find(c => c.recipientPubkey === snapshot.ownerPubkey)
    if (chat && isChatAccepted(chat, context)) return snapshot.ownerPubkey
  } catch { /* Account has not finished loading. */ }
}
function stopMedia() {
  ringtone.stop()
  generation++
  media?.stop(); media = null
  localCallStream.set(null)
  remoteCallVideo.set(null)
  callMediaStats.set(null)
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none'
}
export function knownCallDevices(owner: string): string[] {
  try { return getNdrRuntime().getKnownAppKeysSnapshots().find(s => s.ownerPubkey === owner)?.appKeys.getAllDevices().map(d => d.identityPubkey).filter(p => callOwnerForPeer(`02${p}`) === owner).slice(0, 16) ?? [] } catch { return [] }
}
export function attachCalls(node: FipsNode, peers: () => string[], connect?: (owner: string) => Promise<void>) {
  detachCalls()
  connectedPeers = peers
  connectCallPeers = connect
  session = new CallSession(node, callOwnerForPeer, () => get(callSettings), (owner, id) =>
    // Chat hydration loads its complete message history before admission.
    Array.from(get(chats).values()).some(chat => chat.recipientPubkey === owner &&
      chat.messages.some(message => message.call?.callId === id)),
  )
  session.onEnded = stopMedia
  session.onMedia = frame => media?.receive(frame)
  session.onFeedback = feedback => media?.feedback(feedback)
  session.onKeyframe = () => media?.requestKeyframe()
  let historyKey = ''
  const unsubscribe = session.state.subscribe(state => {
    if (state) {
      const key = JSON.stringify([state.id, state.status, state.video, state.connected, state.endedAt, state.outcome])
      if (key !== historyKey) { historyKey = key; recordCallHistory(state.owner, callHistoryFromState(state)) }
    }
    callState.set(state)
    if (state?.direction === 'incoming' && state.status === 'ringing' && get(callSettings).ringtone !== false) ringtone.start()
    else ringtone.stop()
    if (state) media?.setState(state.status === 'active', state.muted, state.camera, state.video)
  })
  const settingsUnsubscribe = callSettings.subscribe(settings => {
    const state = get(callState)
    if (settings.ringtone === false) ringtone.stop()
    void media?.setQuality(settings).catch(() => callError.set('Could not change call quality'))
    if (state && state.status !== 'ended' && !(state.video ? settings.video || (state.status === 'ringing' && state.direction === 'incoming' && settings.voice) : settings.voice)) session?.end('Calls disabled')
  })
  runtimeCleanup = () => { unsubscribe(); settingsUnsubscribe() }
}
export function detachCalls() {
  session?.dispose()
  runtimeCleanup?.(); runtimeCleanup = undefined
  session = null; connectCallPeers = undefined; stopMedia(); callState.set(null)
}
async function openMedia(video: boolean, capturedSession: CallSession, callId: string) {
  const token = ++generation
  const isCurrent = () => session === capturedSession && get(capturedSession.state)?.id === callId && get(capturedSession.state)?.status !== 'ended'
  const fail = (error: Error) => { if (isCurrent()) { capturedSession.end('Call could not connect'); callError.set(error.message) } }
  const next = new BrowserCallMedia({
    send: frame => isCurrent() ? capturedSession.sendMedia(frame) : Promise.resolve(),
    remoteVideo: canvas => { if (isCurrent()) remoteCallVideo.set(canvas) },
    feedback: feedback => { if (isCurrent()) capturedSession.sendFeedback(feedback) },
    highestVideo: () => isCurrent() ? capturedSession.highestVideo : undefined,
    requestKeyframe: () => { if (isCurrent()) capturedSession.requestKeyframe() },
    stats: stats => { if (isCurrent()) { callMediaStats.set(stats); capturedSession.updateStats(stats.receivedAudio, stats.receivedVideo) } },
    error: fail,
  })
  media = next
  try {
    await next.open(video, get(callSettings))
    if (token !== generation || !isCurrent()) { next.stop(); throw new Error('Call ended') }
    capturedSession.markMediaReady()
    localCallStream.set(next.stream)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: video ? 'Video call' : 'Voice call', artist: 'Iris' })
      navigator.mediaSession.playbackState = 'playing'
      // Supported browsers connect headset and operating-system call controls.
      for (const [action, handler] of [['hangup', endCall], ['togglemicrophone', toggleCallMute], ['togglecamera', toggleCallCamera]] as const) {
        try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler) } catch { /* Browser has no call action support. */ }
      }
    }
    return next
  } catch (error) { next.stop(); if (media === next) media = null; throw error }
}
export async function startCall(owner: string, video: boolean) {
  if (starting || (get(callState) && get(callState)?.status !== 'ended')) return
  starting = true
  callError.set('')
  let startedId: string | undefined
  const initialSession = session
  try {
    if (!session) throw new Error('Calls are not ready yet. Register this device in Settings.')
    if (!(video ? get(callSettings).video : get(callSettings).voice)) return
    const current = session
    // A freshly accepted invite may still be loading the signed device roster.
    if (!knownCallDevices(owner).length) await preparePeerNdrRuntime(owner)
    if (session !== current) return
    const adjacent = connectedPeers().filter(p => callOwnerForPeer(p) === owner)
    // Authenticated device identities are routable even without a direct link.
    current.start(owner, [...adjacent, ...knownCallDevices(owner).map(device => `02${device.toLowerCase()}`)], video)
    startedId = get(current.state)?.id
    // NAT traversal must not delay or prevent an offer on the existing FIPS route.
    if (!adjacent.length) void connectCallPeers?.(owner).catch(() => {})
    await openMedia(video, current, startedId!)
    const state = get(callState)
    if (state) media?.setState(state.status === 'active', state.muted, state.camera, state.video)
  } catch (error) {
    if (session === initialSession && (!startedId || (get(callState)?.id === startedId && get(callState)?.status !== 'ended'))) {
      session?.end('Call could not start'); callError.set(error instanceof Error ? error.message : 'Microphone or camera unavailable')
    }
  } finally { starting = false }
}
export async function answerCall(video: boolean) {
  callError.set('')
  const current = session, state = get(callState)
  if (!current || state?.direction !== 'incoming' || state.status !== 'ringing' || answersInFlight.has(state.id)) return
  const withVideo = video && state.video && get(callSettings).video
  if (!withVideo && !get(callSettings).voice) return
  answersInFlight.add(state.id)
  ringtone.stop()
  try {
    const captured = await openMedia(withVideo, current, state.id)
    if (session !== current || get(callState)?.id !== state.id || get(callState)?.status !== 'ringing') {
      captured.stop()
      if (media === captured) { media = null; localCallStream.set(null) }
      return
    }
    current.accept(withVideo)
  } catch (error) {
    if (session === current && get(callState)?.id === state.id && get(callState)?.status === 'ringing') {
      current.end('Microphone or camera unavailable'); callError.set(error instanceof Error ? error.message : 'Microphone or camera unavailable')
    }
  } finally { answersInFlight.delete(state.id) }
}
export function endCall() {
  const state = get(callState)
  session?.end('Call ended', true, state?.direction === 'incoming' && state.status === 'ringing' ? 'declined' : undefined)
}
export function dismissCall() { session?.clear(); callError.set('') }
export function toggleCallMute() { const s = get(callState); if (s) session?.setMedia(!s.muted, s.camera) }
export function toggleCallCamera() { const s = get(callState); if (s?.video) session?.setMedia(s.muted, !s.camera) }
