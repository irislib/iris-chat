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
vi.mock('./chat', () => ({ chats: writable(new Map([['contact', { recipientPubkey: 'c'.repeat(64), messages: [] }]])) }))
vi.mock('./privateChats', () => ({ getNdrRuntime: () => ({ getKnownAppKeysSnapshots: () => [{ ownerPubkey: 'c'.repeat(64), appKeys: { getAllDevices: () => [{ identityPubkey: 'b'.repeat(64) }] } }] }) }))
vi.mock('./messageRequestPolicy', () => ({ getMessageRequestPolicyContext: () => ({ myPubkey: 'a'.repeat(64) }), isChatAccepted: () => true, isChatRejected: () => false }))
vi.mock('./callMedia', () => ({ BrowserCallMedia: class {
  stream = {} as MediaStream
  stop = vi.fn()
  setState = vi.fn()
  receive = vi.fn()
  open = () => new Promise<void>(resolve => { fixture.media.push({ finish: resolve, stop: this.stop }) })
} }))
import { attachCalls, detachCalls, answerCall, callState } from './calls'
import { callSettings } from './callSettings'

describe('answer capture ownership', () => {
  beforeEach(() => {
    fixture.media.length = 0
    callSettings.set({ voice: true, video: true })
    attachCalls({ registerService: (_port: number, handler: typeof fixture.receive) => { fixture.receive = handler; return () => {} }, sendDatagram: vi.fn(async () => {}) } as unknown as FipsNode, () => [peer])
  })
  afterEach(() => detachCalls())
  const offer = (id: string) => fixture.receive?.({ src: peer, payload: encodeCallControl({ v: 1, type: 'offer', call_id: id, video: true }) })
  it('opens capture once when Answer is invoked twice while permission is pending', async () => {
    offer('ab'.repeat(16))
    expect(get(callState)?.owner).toBe(owner)
    const first = answerCall(true), second = answerCall(true)
    expect(fixture.media).toHaveLength(1)
    fixture.media[0].finish()
    await Promise.all([first, second])
    expect(get(callState)?.status).toBe('active')
    expect(fixture.media[0].stop).not.toHaveBeenCalled()
  })
  it('a late permission result from an ended call cannot stop a newer call', async () => {
    const oldId = 'ab'.repeat(16), newId = 'cd'.repeat(16)
    offer(oldId)
    const first = answerCall(true)
    fixture.receive?.({ src: peer, payload: encodeCallControl({ v: 1, type: 'end', call_id: oldId }) })
    offer(newId)
    const second = answerCall(false)
    fixture.media[1].finish(); await second
    fixture.media[0].finish(); await first
    expect(get(callState)?.id).toBe(newId)
    expect(get(callState)?.status).toBe('active')
    expect(get(callState)?.video).toBe(false)
    expect(fixture.media[1].stop).not.toHaveBeenCalled()
  })
})
