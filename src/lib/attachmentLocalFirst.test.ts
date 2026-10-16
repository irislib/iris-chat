// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { HashTree, nhashDecode, nhashEncode, MemoryStore } from '@hashtree/core'
import { TcpBlobTransport } from '@hashtree/fips-transport'
import type { FipsDatagramEndpoint, FipsServiceContext } from '@fips/tcp'
import { AttachmentStore } from './attachmentStore'
vi.mock('./identity', () => ({ getPubkey: vi.fn(), getPrivkeyBytes: vi.fn(), isNip07Login: () => false, isLinkedDeviceLogin: () => false }))
import { getPubkey, getPrivkeyBytes } from './identity'
import { uploadFile, downloadFile, setAttachmentAccount, getAttachmentCache, activateAttachmentPeers, deactivateAttachmentPeers } from './hashtree'
afterEach(async () => { setAttachmentAccount(null); await new Promise(resolve => setTimeout(resolve, 0)); vi.unstubAllGlobals(); await getAttachmentCache().db.transaction('rw', getAttachmentCache().db.tables, async () => { for (const table of getAttachmentCache().db.tables) await table.clear() }) })
it('accepts the production upload before unavailable HTTP completes, and reads the encrypted tree after a database reopen', async () => {
  const secret = generateSecretKey(); vi.mocked(getPubkey).mockReturnValue(getPublicKey(secret)); vi.mocked(getPrivkeyBytes).mockReturnValue(secret)
  vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('offline')), { once: true })
  })))
  const bytes = new Uint8Array(2 * 1024 * 1024 + 30).fill(57)
  const result = await uploadFile(new File([bytes], 'offline.bin'))
  expect(await downloadFile(result.nhash)).toEqual(bytes)
  expect((await getAttachmentCache().receipts(getPubkey()!, [result.nhash]))[0]!.uploadedUrls).toEqual([])
  setAttachmentAccount(null)
  const reopened = new AttachmentStore()
  expect(await new HashTree({ store: reopened }).readFile(nhashDecode(result.nhash))).toEqual(bytes)
  reopened.close()
}, 10_000)
it('cleans a partial local write when the account changes instead of returning a cross-account attachment', async () => {
  const secret = generateSecretKey(); vi.mocked(getPubkey).mockReturnValue(getPublicKey(secret)); vi.mocked(getPrivkeyBytes).mockReturnValue(secret)
  const before = await getAttachmentCache().stats()
  await expect(uploadFile(new File([new Uint8Array(2 * 1024 * 1024 + 20)], 'changing.bin'), () => {
    vi.mocked(getPubkey).mockReturnValue('b'.repeat(64)); setAttachmentAccount('b'.repeat(64))
  })).rejects.toThrow('Account changed')
  expect(await getAttachmentCache().stats()).toEqual(before)
})

it.each([true, false])('fetches ciphertext with a hanging first provider and odd Noise parity (transport ready initially: %s)', async (readyInitially: boolean) => {
  const secret = generateSecretKey(); vi.mocked(getPubkey).mockReturnValue(getPublicKey(secret)); vi.mocked(getPrivkeyBytes).mockReturnValue(secret)
  setAttachmentAccount(getPubkey())
  const handlers = [new Map<number, (context: FipsServiceContext) => void | Promise<void>>(), new Map<number, (context: FipsServiceContext) => void | Promise<void>>()] as const
  const peers = ['03' + 'a'.repeat(64), '03' + 'b'.repeat(64)]
  const endpoint = (side: number): FipsDatagramEndpoint => ({
    registerService(port, handler) { handlers[side]!.set(port, handler); return () => { handlers[side]!.delete(port) } },
    async sendDatagram(args) {
      if (args.dst.slice(2) === 'c'.repeat(64)) return new Promise<void>(() => {})
      expect(args.dst.slice(2)).toBe(peers[1 - side]!.slice(2))
      queueMicrotask(() => { void handlers[1 - side]!.get(args.dstPort)?.({ src: peers[side]!, srcPort: args.srcPort!, dstPort: args.dstPort, payload: args.payload }) })
    },
  })
  const store = new MemoryStore(), bytes = new Uint8Array(170_000).fill(91)
  const result = await new HashTree({ store, chunkSize: 65_536 }).putFile(bytes)
  const server = new TcpBlobTransport({ endpoint: endpoint(1), localStore: store, allowIncomingPeer: peer => peer.slice(2) === peers[0]!.slice(2) })
  const http = vi.fn(() => { throw new Error('HTTP unavailable') }); vi.stubGlobal('fetch', http)
  const activate = () => activateAttachmentPeers(endpoint(0), () => ['02' + 'c'.repeat(64), '02' + peers[1]!.slice(2)], peer => peer.slice(2) === peers[1]!.slice(2))
  if (readyInitially) activate()
  try {
    const download = downloadFile(nhashEncode(result.cid))
    void download.catch(() => {})
    if (!readyInitially) { await vi.waitFor(() => expect(http).toHaveBeenCalled()); activate() }
    expect(await download).toEqual(bytes)
    if (readyInitially) expect(http).not.toHaveBeenCalled()
  }
  finally { await deactivateAttachmentPeers(); await server.close() }
}, 10_000)

it('cancels a startup download on account change and releases its reader journal', async () => {
  const secret = generateSecretKey(); vi.mocked(getPubkey).mockReturnValue(getPublicKey(secret)); vi.mocked(getPrivkeyBytes).mockReturnValue(secret)
  const result = await new HashTree({ store: new MemoryStore() }).putFile(new Uint8Array(5).fill(9))
  const http = vi.fn(() => { throw new Error('HTTP unavailable') }); vi.stubGlobal('fetch', http)
  const download = downloadFile(nhashEncode(result.cid))
  const outcome = download.then(() => undefined, error => error as Error)
  await vi.waitFor(() => expect(http).toHaveBeenCalled())
  vi.mocked(getPubkey).mockReturnValue('b'.repeat(64)); setAttachmentAccount('b'.repeat(64))
  expect((await outcome)?.message).toBe('Account changed')
  expect((await getAttachmentCache().stats()).files).toBe(0)
})
