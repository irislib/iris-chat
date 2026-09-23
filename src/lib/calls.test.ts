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
import { recordCallHistory } from './chat'
import { attachCalls, detachCalls, answerCall, callState } from './calls'
import { callSettings } from './callSettings'

describe('answer capture ownership', () => {
  beforeEach(() => {
    fixture.media.length = 0
    vi.mocked(recordCallHistory).mockClear()
    callSettings.set({ voice: true, video: true })
    attachCalls({ registerService: (_port: number, handler: typeof fixture.receive) => { fixture.receive = handler; return () => {} }, sendDatagram: vi.fn(async () => {}) } as unknown as FipsNode, () => [peer])
  })
  afterEach(() => detachCalls())
  const offer = (id: string) => fixture.receive?.({ src: peer, payload: encodeCallControl({ v: 3, type: 'offer', call_id: id, video: true }) })
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
