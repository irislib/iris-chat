import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import type { FipsNode } from '@fips/core'
import { encodeCallControl } from './callProtocol'

const fixture = vi.hoisted(() => ({
  media: [] as Array<{ finish: () => void; stop: ReturnType<typeof vi.fn> }>,
  receive: undefined as ((context: { src: string; payload: Uint8Array }) => void) | undefined,
}))
const peer = `02${'b'.repeat(64)}`
const owner = 'c'.repeat(64)
vi.mock('./chat', () => ({ recordCallHistory: vi.fn(), chats: writable(new Map([['contact', { recipientPubkey: 'c'.repeat(64), messages: [] }]])) }))
vi.mock('./privateChats', () => ({ getNdrRuntime: () => ({ getKnownAppKeysSnapshots: () => [{ ownerPubkey: 'c'.repeat(64), appKeys: { getAllDevices: () => [{ identityPubkey: 'b'.repeat(64) }] } }] }) }))
vi.mock('./messageRequestPolicy', () => ({ getMessageRequestPolicyContext: () => ({ myPubkey: 'a'.repeat(64) }), isChatAccepted: () => true, isChatRejected: () => false }))
vi.mock('./callMedia', () => ({ BrowserCallMedia: class {
  stream = {} as MediaStream
  stop = vi.fn()
  setState = vi.fn()
  setQuality = vi.fn(async () => {})
  open = () => new Promise<void>(resolve => { fixture.media.push({ finish: resolve, stop: this.stop }) })
} }))
import { chats, recordCallHistory } from './chat'
import { callHistoryLabel, type CallHistory } from './callHistory'
import { attachCalls, detachCalls, answerCall, startCall, callState } from './calls'
import { callSettings } from './callSettings'

describe('answer capture ownership', () => {
  beforeEach(() => {
    fixture.media.length = 0
    chats.set(new Map([['contact', { id: 'contact', recipientPubkey: owner, mode: 'manager', messages: [] }]]))
    vi.mocked(recordCallHistory).mockClear()
    callSettings.set({ voice: true, video: true })
    attachCalls({ registerService: (_port: number, handler: typeof fixture.receive) => { fixture.receive = handler; return () => {} }, sendDatagram: vi.fn(async () => {}) } as unknown as FipsNode, () => [peer])
  })
  afterEach(() => detachCalls())
  const offer = (id: string) => fixture.receive?.({ src: peer, payload: encodeCallControl({ v: 3, type: 'offer', call_id: id, video: true }) })
  it.each(['stalled', 'failed'])('starts a routed call to a verified device when direct connection setup is %s', async (state: string) => {
    const seed = `02${'e'.repeat(64)}`
    const send = vi.fn(async () => {})
    const connect = vi.fn(() => state === 'stalled' ? new Promise<void>(() => {}) : Promise.reject(new Error('Direct connection unavailable')))
    attachCalls({
      registerService: (_port: number, handler: typeof fixture.receive) => { fixture.receive = handler; return () => {} },
      sendDatagram: send,
    } as unknown as FipsNode, () => [seed], connect)
    const starting = startCall(owner, false)
    await vi.waitFor(() => expect(fixture.media).toHaveLength(1))
    fixture.media[0].finish()
    await starting
    expect(get(callState)).toMatchObject({ status: 'ringing', peers: [peer] })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ dst: peer }))
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ dst: seed }))
    expect(connect).toHaveBeenCalledWith(owner)
  })
  it('sends one wakeup without waiting for push delivery', async () => {
    const wake = vi.fn(() => new Promise<void>(() => {}))
    attachCalls({ registerService: () => () => {}, sendDatagram: vi.fn(async () => {}) } as unknown as FipsNode,
      () => [peer], undefined, wake)
    const starting = startCall(owner, false)
    await vi.waitFor(() => expect(fixture.media).toHaveLength(1))
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ peers: [peer], direction: 'outgoing', status: 'ringing' }))
    fixture.media[0].finish()
    await starting
  })
  it('does not ring a persisted call again after the session is recreated', () => {
    const oldId = 'ab'.repeat(16), newId = 'cd'.repeat(16)
    offer(oldId)
    fixture.receive?.({ src: peer, payload: encodeCallControl({ v: 3, type: 'end', call_id: oldId }) })
    const finished = structuredClone(vi.mocked(recordCallHistory).mock.calls.at(-1)![1])
    detachCalls()
    const message = (call: CallHistory) => ({ id: `call:${call.callId}`, call,
      content: callHistoryLabel(call), timestamp: call.startedAt, isMine: false })
    // The normal storage load restores each conversation's complete history.
    chats.set(new Map([
      ['contact', { id: 'contact', recipientPubkey: owner, mode: 'manager', messages: [message(finished)] }],
      ['other', { id: 'other', recipientPubkey: 'f'.repeat(64), mode: 'manager', messages: [message({ ...finished, callId: newId })] }],
    ]))
    attachCalls({ registerService: (_port: number, handler: typeof fixture.receive) => { fixture.receive = handler; return () => {} }, sendDatagram: vi.fn(async () => {}) } as unknown as FipsNode, () => [peer])
    vi.mocked(recordCallHistory).mockClear()
    offer(oldId)
    expect(get(callState)).toBeNull()
    expect(recordCallHistory).not.toHaveBeenCalled()
    // IDs belonging to a different authenticated person cannot suppress a call.
    offer(newId)
    expect(get(callState)?.id).toBe(newId)
    const pending = vi.mocked(recordCallHistory).mock.calls.at(-1)![1]
    chats.update(all => {
      const chat = all.get('contact')!
      all.set('contact', { ...chat, messages: [...chat.messages, message(pending)] })
      return all
    })
    offer(newId)
    expect(get(callState)?.status).toBe('ringing')
  })
  it('cannot write old call history after teardown and an account runtime change', async () => {
    const oldId = 'ab'.repeat(16)
    offer(oldId)
    const oldEndpointHandler = fixture.receive
    const answer = answerCall(false)
    await vi.waitFor(() => expect(fixture.media).toHaveLength(1))
    // Logout awaits this teardown before clearing chats or enabling a new login.
    detachCalls()
    chats.set(new Map([['new-account-chat', { id: 'new-account-chat', recipientPubkey: owner, mode: 'manager', messages: [] }]]))
    attachCalls({ registerService: (_port: number, handler: typeof fixture.receive) => { fixture.receive = handler; return () => {} }, sendDatagram: vi.fn(async () => {}) } as unknown as FipsNode, () => [peer])
    vi.mocked(recordCallHistory).mockClear()
    oldEndpointHandler?.({ src: peer, payload: encodeCallControl({ v: 3, type: 'end', call_id: oldId }) })
    fixture.media[0].finish()
    await answer
    expect(get(callState)).toBeNull()
    expect(recordCallHistory).not.toHaveBeenCalled()
    expect(fixture.media[0].stop).toHaveBeenCalled()
  })
  it('does not create history from an unverified offer', () => {
    fixture.receive?.({ src: `02${'f'.repeat(64)}`, payload: encodeCallControl({ v: 3, type: 'offer', call_id: 'ab'.repeat(16), video: false }) })
    expect(get(callState)).toBeNull()
    expect(recordCallHistory).not.toHaveBeenCalled()
  })
  it('opens capture once when Answer is invoked twice while permission is pending', async () => {
    offer('ab'.repeat(16))
    expect(get(callState)?.owner).toBe(owner)
    const first = answerCall(true), second = answerCall(true)
    await vi.waitFor(() => expect(fixture.media).toHaveLength(1))
    fixture.media[0].finish()
    await Promise.all([first, second])
    expect(get(callState)?.status).toBe('active')
    expect(recordCallHistory).toHaveBeenLastCalledWith(owner, expect.objectContaining({ callId: 'ab'.repeat(16), outcome: 'answered', video: true }))
    expect(fixture.media[0].stop).not.toHaveBeenCalled()
  })
  it('a late permission result from an ended call cannot stop a newer call', async () => {
    const oldId = 'ab'.repeat(16), newId = 'cd'.repeat(16)
    offer(oldId)
    const first = answerCall(true)
    await vi.waitFor(() => expect(fixture.media).toHaveLength(1))
    fixture.receive?.({ src: peer, payload: encodeCallControl({ v: 3, type: 'end', call_id: oldId }) })
    offer(newId)
    const second = answerCall(false)
    await vi.waitFor(() => expect(fixture.media).toHaveLength(2))
    fixture.media[1].finish(); await second
    fixture.media[0].finish(); await first
    expect(get(callState)?.id).toBe(newId)
    expect(get(callState)?.status).toBe('active')
    expect(get(callState)?.video).toBe(false)
    expect(fixture.media[1].stop).not.toHaveBeenCalled()
  })
})
