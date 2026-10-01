// @vitest-environment node
import { get, writable, type Writable } from 'svelte/store'
import { File } from 'node:buffer'
import { getPublicKey } from 'nostr-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FipsDatagramEndpoint } from '@fips/tcp'
import type { DirectFileTcpOptions } from './directFileTcp'

const state = vi.hoisted(() => ({
  owner: 'ab'.repeat(32), blocked: false, saved: new Map<string, unknown>(),
  readFile: vi.fn(),
  transports: [] as Array<{ options: DirectFileTcpOptions; registerOffer: ReturnType<typeof vi.fn>;
    receive: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }>,
}))
vi.mock('./chat', () => {
  const chats = writable(new Map())
  return { chats, sendMessage: vi.fn(async (chat: ChatSession, content: string) => {
    chats.update(all => new Map(all).set(chat.id, { ...chat, messages: [...chat.messages,
      { id: 'offered', content, timestamp: Date.now(), isMine: true }] }))
  }) }
})
vi.mock('./identity', () => ({ getPubkey: () => state.owner }))
vi.mock('./devices', () => ({ devices: writable({ registeredDevices: [] }) }))
vi.mock('./privateChats', () => ({
  preparePeerNdrRuntime: vi.fn(async () => undefined),
  getNdrRuntime: () => ({ getKnownAppKeysSnapshots: () => [] }),
}))
vi.mock('./messageRequestPolicy', () => ({
  getMessageRequestPolicyContext: () => ({}), isChatRejected: () => state.blocked,
}))
vi.mock('./messageRequests', () => ({ acceptChat: vi.fn() }))
vi.mock('./storage', () => ({
  getSessionManagerValue: vi.fn(async (key: string) => state.saved.get(key)),
  putSessionManagerValue: vi.fn(async (key: string, value: unknown) => { state.saved.set(key, value) }),
}))
vi.mock('./directFileTcp', () => ({ DirectFileTcp: class {
  registerOffer = vi.fn()
  receive = vi.fn(async () => undefined)
  decline = vi.fn(async () => undefined)
  cancel = vi.fn()
  restrictOffer = vi.fn()
  dispose = vi.fn(async () => undefined)
  constructor(public options: DirectFileTcpOptions) { state.transports.push(this) }
} }))
vi.mock('./directFileStorage', () => ({ DirectFileStorage: class { getFile = state.readFile } }))

import { chats, sendMessage, type ChatSession } from './chat'
import { devices } from './devices'
import { attachDirectFiles, detachDirectFiles, directFileTransfers, sendDirectFiles, acceptDirectFiles,
  cancelDirectFiles, downloadDirectFile } from './directFiles'
import { parseDirectFileOffer, signDirectFileOffer, type DirectFileOffer } from './directFileProtocol'

const secret = new Uint8Array(32).fill(1)
const siblingSecret = new Uint8Array(32).fill(2)
const local = getPublicKey(secret)
const sibling = getPublicKey(siblingSecret)
const connect = vi.fn(async () => undefined)
const chat = (): ChatSession => ({ id: state.owner, recipientPubkey: state.owner, mode: 'manager', messages: [] })
function incomingOffer(): DirectFileOffer {
  return { id: '01'.repeat(16), token: '02'.repeat(32), owner: state.owner, recipient: state.owner,
    device: sibling, caption: '', expires_at_secs: Math.floor(Date.now() / 1000) + 3600,
    files: [{ filename: 'notes.txt', size_bytes: 5, sha256: '03'.repeat(32) }],
  }
}
async function receiveOffer(value = incomingOffer(), isMine = true): Promise<string> {
  const wire = signDirectFileOffer(value, siblingSecret)
  chats.set(new Map([[state.owner, { ...chat(), messages: [{ id: 'incoming', content: wire,
    timestamp: Date.now(), isMine }] }]]))
  await vi.waitFor(() => expect(get(directFileTransfers).has(value.id)).toBe(true))
  return value.id
}

describe('direct-file app consent and device roles', () => {
  beforeEach(async () => {
    state.owner = 'ab'.repeat(32)
    state.blocked = false; state.saved.clear(); state.transports.length = 0
    state.readFile.mockReset().mockRejectedValue(new Error('File not found'))
    vi.mocked(sendMessage).mockClear(); connect.mockClear()
    ;(devices as unknown as Writable<unknown>).set({ identityPubkey: local,
      registeredDevices: [local, sibling].map(identityPubkey => ({ identityPubkey })) })
    chats.set(new Map([[state.owner, chat()]]))
    await attachDirectFiles({} as FipsDatagramEndpoint, state.owner, secret, connect)
  })
  afterEach(detachDirectFiles)

  it('offers immutable files to another own device without uploading or reading on the receiver', async () => {
    const files = [new File(['hello'], 'notes.txt'), new File([], 'empty.txt')]
    await sendDirectFiles(chat(), files as unknown as globalThis.File[], 'Laptop copy')
    const tcp = state.transports[0]!
    const wire = vi.mocked(sendMessage).mock.calls[0]![1]
    const offer = parseDirectFileOffer(wire)!
    expect(offer.owner).toBe(offer.recipient)
    expect(offer.device).toBe(local)
    expect(tcp.registerOffer.mock.calls[0]![2]).toEqual([sibling])
    expect(tcp.receive).not.toHaveBeenCalled()
    expect(get(directFileTransfers).get(offer.id)).toMatchObject({ isSender: true, status: 'offered', totalBytes: 5 })
    await detachDirectFiles()
    const stored = state.saved.get(`v1/direct-files/${state.owner}/${local}/${offer.id}`) as { files: object[] }
    expect(stored.files.every(file => !('blob' in file))).toBe(true)
  })

  it('lets a self-chat outgoing message be accepted only by the other device', async () => {
    const id = await receiveOffer()
    const tcp = state.transports[0]!
    expect(get(directFileTransfers).get(id)).toMatchObject({ isSender: false, status: 'offered' })
    expect(tcp.receive).not.toHaveBeenCalled()
    await acceptDirectFiles(id)
    expect(tcp.receive).toHaveBeenCalledWith(id, incomingOffer().token, sibling,
      [expect.objectContaining({ filename: 'notes.txt', sizeBytes: 5 })])
  })

  it('rejects an unrelated device and a revoked device before accepting', async () => {
    const id = await receiveOffer()
    ;(devices as unknown as Writable<unknown>).set({ registeredDevices: [{ identityPubkey: local }] })
    await expect(acceptDirectFiles(id)).rejects.toThrow('no longer available')
    expect(state.transports[0]!.receive).not.toHaveBeenCalled()
  })

  it('does not admit a claimed owner that differs from the authenticated chat author', async () => {
    const offer = { ...incomingOffer(), owner: 'ff'.repeat(32) }
    const wire = signDirectFileOffer(offer, siblingSecret)
    chats.set(new Map([[state.owner, { ...chat(), messages: [{ id: 'spoof', content: wire,
      timestamp: Date.now(), isMine: true }] }]]))
    await Promise.resolve(); await Promise.resolve()
    expect(get(directFileTransfers).size).toBe(0)
    expect(state.transports[0]!.receive).not.toHaveBeenCalled()
  })

  it('honors cancellation while connecting and ignores late transport completion', async () => {
    const id = await receiveOffer()
    let resolve!: () => void
    connect.mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    const pending = acceptDirectFiles(id)
    await vi.waitFor(() => expect(get(directFileTransfers).get(id)?.status).toBe('connecting'))
    await cancelDirectFiles(id)
    resolve(); await pending
    state.transports[0]!.options.onEvent({ type: 'completed', transferId: id, peer: sibling })
    expect(state.transports[0]!.receive).not.toHaveBeenCalled()
    expect(get(directFileTransfers).get(id)?.status).toBe('cancelled')
  })

  it('claims an offer once when two copies of its card accept concurrently', async () => {
    const id = await receiveOffer()
    const results = await Promise.allSettled([acceptDirectFiles(id), acceptDirectFiles(id)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(state.transports[0]!.receive).toHaveBeenCalledTimes(1)
    expect(get(directFileTransfers).get(id)?.status).toBe('connecting')
  })

  it('quiesces an in-flight offer before an account switch without publishing into the next account', async () => {
    let release!: () => void
    vi.mocked(sendMessage).mockImplementationOnce(async (_chat: ChatSession, _wire: string, _reply?: string, isCurrent?: () => boolean) => {
      await new Promise<void>(resolve => { release = resolve })
      if (!isCurrent?.()) throw new Error('The sending device has changed')
    })
    const pending = sendDirectFiles(chat(), [new File(['secret'], 'private.txt')] as unknown as globalThis.File[])
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    state.owner = 'ef'.repeat(32)
    chats.set(new Map([[state.owner, chat()]]))
    const next = attachDirectFiles({} as FipsDatagramEndpoint, state.owner, secret, connect)
    release()
    await expect(pending).rejects.toThrow('sending device has changed')
    await next
    expect(get(directFileTransfers).size).toBe(0)
    expect([...state.saved.keys()].some(key => key.includes(state.owner))).toBe(false)
  })

  it('does not download old-account local files after an account closes', async () => {
    const id = await receiveOffer()
    await acceptDirectFiles(id)
    state.transports[0]!.options.onEvent({ type: 'completed', transferId: id, peer: sibling })
    let release!: (file: Blob) => void
    state.readFile.mockImplementationOnce(() => new Promise<Blob>(resolve => { release = resolve }))
    const pending = downloadDirectFile(id, 0)
    await detachDirectFiles()
    release(new Blob(['hello']))
    await expect(pending).rejects.toThrow('no longer available')
  })

  it('shows readable failures without exposing internal peer addresses', async () => {
    const id = await receiveOffer()
    state.transports[0]!.options.onEvent({ type: 'failed', transferId: id, peer: sibling,
      error: `no route to ${sibling}` })
    expect(get(directFileTransfers).get(id)?.error).toBe('Couldn’t reach the other device. Keep both apps open.')
  })

  it('keeps sent files in chat history after reopening without the original browser files', async () => {
    await sendDirectFiles(chat(), [new File(['hello'], 'notes.txt')] as unknown as globalThis.File[])
    const message = get(chats).get(state.owner)!.messages[0]!
    const id = parseDirectFileOffer(message.content)!.id
    state.transports[0]!.options.onEvent({ type: 'completed', transferId: id, peer: sibling })
    await detachDirectFiles()
    await attachDirectFiles({} as FipsDatagramEndpoint, state.owner, secret, connect)
    await vi.waitFor(() => expect(get(directFileTransfers).get(id)?.status).toBe('completed'))
    expect(get(chats).get(state.owner)!.messages).toEqual([message])
    expect(get(directFileTransfers).get(id)).toMatchObject({ isSender: true, transferredBytes: 5,
      files: [{ filename: 'notes.txt', sizeBytes: 5, canDownload: false }] })
  })

  it.each([true, false])('keeps failed transfer history after reopening (sender=%s)', async (isSender: boolean) => {
    let id: string
    if (isSender) {
      await sendDirectFiles(chat(), [new File(['hello'], 'notes.txt')] as unknown as globalThis.File[])
      id = parseDirectFileOffer(get(chats).get(state.owner)!.messages[0]!.content)!.id
    } else id = await receiveOffer()
    const messages = get(chats).get(state.owner)!.messages
    state.transports[0]!.options.onEvent({ type: 'failed', transferId: id, peer: sibling,
      error: 'Received file did not match the offer' })
    await detachDirectFiles()
    await attachDirectFiles({} as FipsDatagramEndpoint, state.owner, secret, connect)
    await vi.waitFor(() => expect(get(directFileTransfers).get(id)?.status).toBe('failed'))
    expect(get(chats).get(state.owner)!.messages).toEqual(messages)
    expect(get(directFileTransfers).get(id)).toMatchObject({ isSender,
      error: 'These files could not be verified. Please send them again.',
      files: [{ filename: 'notes.txt', sizeBytes: 5, canDownload: false }] })
  })

  it('keeps received history even when a saved local file is no longer available', async () => {
    const id = await receiveOffer()
    await acceptDirectFiles(id)
    state.transports[0]!.options.onEvent({ type: 'completed', transferId: id, peer: sibling,
      files: [{ filename: 'notes.txt', blob: new Blob(['hello']) }] })
    state.readFile.mockResolvedValue(new Blob(['hello']))
    await detachDirectFiles()
    await attachDirectFiles({} as FipsDatagramEndpoint, state.owner, secret, connect)
    await vi.waitFor(() => expect(get(directFileTransfers).get(id)?.files[0]?.canDownload).toBe(true))
    state.readFile.mockRejectedValue(new Error('File not found'))
    await detachDirectFiles()
    await attachDirectFiles({} as FipsDatagramEndpoint, state.owner, secret, connect)
    await vi.waitFor(() => expect(get(directFileTransfers).get(id)?.status).toBe('completed'))
    expect(get(chats).get(state.owner)!.messages).toHaveLength(1)
    expect(get(directFileTransfers).get(id)).toMatchObject({ isSender: false, transferredBytes: 5,
      files: [{ filename: 'notes.txt', sizeBytes: 5, canDownload: false }] })
  })
})
