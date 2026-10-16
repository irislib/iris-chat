// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { HashTree, nhashEncode, nhashDecode, sha256, toHex, type BlossomSigner } from '@hashtree/core'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import { AttachmentStore } from './attachmentStore'
import { AttachmentReplication, uploadEncryptedBlock } from './attachmentReplication'
const owner = 'a'.repeat(64), server = 'https://files.example', secret = generateSecretKey()
const signer: BlossomSigner = async event => finalizeEvent(event, secret)
const stores: AttachmentStore[] = [], workers: AttachmentReplication[] = []
afterEach(async () => { for (const worker of workers.splice(0)) worker.stop(); vi.unstubAllGlobals(); for (const store of stores.splice(0)) { store.close(); await store.db.delete() } })
function create(name = crypto.randomUUID(), now?: () => number) { const store = new AttachmentStore(name, 4096, now); stores.push(store); return store }
async function stage(store: AttachmentStore) {
  const bytes = new Uint8Array(180).fill(47), id = await store.begin(owner, [server])
  const file = await new HashTree({ store: store.writer(id), chunkSize: 64 }).putFile(bytes)
  const nhash = nhashEncode(file.cid); await store.finish(id, nhash, file.cid.hash)
  return { bytes, nhash, id }
}
function worker(store: AttachmentStore, current = () => true) { const w = new AttachmentReplication(store, owner, signer, current); workers.push(w); return w }
it('keeps complete ciphertext locally during outage and retries after restart, recording only complete-tree acknowledgement', async () => {
  let time = 0; const name = crypto.randomUUID(), store = create(name, () => time), file = await stage(store)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  const first = worker(store); await first.step()
  expect(await new HashTree({ store }).readFile(nhashDecode(file.nhash))).toEqual(file.bytes)
  expect((await store.receipts(owner, [file.nhash]))[0]!.uploadedUrls).toEqual([])
  expect(await first.step()).toBe(false)
  first.stop(); store.close(); time = 6000
  const restarted = create(name, () => time), resumed = worker(restarted), received = new Map<string, Uint8Array>()
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer()), hash = toHex(await sha256(bytes)); received.set(hash, bytes)
    return Response.json({ sha256: hash, size: bytes.length })
  }))
  expect(await resumed.step()).toBe(true)
  expect((await restarted.receipts(owner, [file.nhash]))[0]!.uploadedUrls).toEqual([])
  for (let i = 0; i < 8 && await resumed.step(); i++) { /* each production step acknowledges one block */ }
  expect((await restarted.receipts(owner, [file.nhash]))[0]!.uploadedUrls).toHaveLength(1)
  const remote = new HashTree({ store: { get: async hash => received.get(toHex(hash)) ?? null, put: async () => false, has: async hash => received.has(toHex(hash)), delete: async () => false } })
  expect(await remote.readFile(nhashDecode(file.nhash))).toEqual(file.bytes)
})
it('cancels an in-flight request on account change without acknowledging it or leaving a lease', async () => {
  const store = create(), file = await stage(store); let current = true, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    entered(); init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })))
  const running = worker(store, () => current), step = running.step(); await started
  current = false; running.stop(); await step
  expect(await running.step()).toBe(false)
  expect((await store.receipts(owner, [file.nhash]))[0]!.uploadedUrls).toEqual([])
  expect(await store.claim(owner, 'new-session')).toBeDefined()
  expect(await store.claim('b'.repeat(64), 'other-account')).toBeUndefined()
})
it('rejects a false server descriptor and never exposes the encryption key in requests', async () => {
  const bytes = new Uint8Array(20), hash = toHex(await sha256(bytes))
  const fetcher = vi.fn(async () => Response.json({ sha256: 'b'.repeat(64) })); vi.stubGlobal('fetch', fetcher)
  await expect(uploadEncryptedBlock(server, hash, bytes, signer, new AbortController().signal)).rejects.toThrow('different attachment')
  expect(fetcher.mock.calls).toHaveLength(1)
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe(`${server}/upload`)
  expect(init.redirect).toBe('error'); expect(init.credentials).toBe('omit')
  expect(JSON.stringify(init.headers)).not.toContain('nhash')
})
it('continues with a healthy server when another server is offline and does not mark the failed server complete', async () => {
  const store = create(), bytes = new Uint8Array(180).fill(9), id = await store.begin(owner, ['https://offline.example', server])
  const file = await new HashTree({ store: store.writer(id), chunkSize: 64 }).putFile(bytes), nhash = nhashEncode(file.cid)
  await store.finish(id, nhash, file.cid.hash)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith('https://offline.example')) throw new Error('offline')
    const data = new Uint8Array(await (init.body as Blob).arrayBuffer())
    return Response.json({ sha256: toHex(await sha256(data)), size: data.length })
  }))
  const active = worker(store)
  for (let i = 0; i < 8 && await active.step(); i++) { /* eligible servers remain independent */ }
  expect((await store.receipts(owner, [nhash]))[0]!.uploadedUrls).toEqual([`${server}/${toHex(file.cid.hash)}.bin`])
})

it('releases a job promptly if an extension signature is still pending at logout', async () => {
  const store = create(), file = await stage(store); let signStarted!: () => void
  const started = new Promise<void>(resolve => { signStarted = resolve })
  const delayed: BlossomSigner = () => { signStarted(); return new Promise(() => {}) }
  const active = new AttachmentReplication(store, owner, delayed, () => true); workers.push(active)
  const pending = active.step(); await started; active.stop(); await pending
  expect((await store.receipts(owner, [file.nhash]))[0]!.uploadedUrls).toEqual([])
  expect(await store.claim(owner, 'next')).toBeDefined()
})

it('bounds server acknowledgement metadata before parsing it', async () => {
  const bytes = new Uint8Array(20), hash = toHex(await sha256(bytes))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(20_000))))
  await expect(uploadEncryptedBlock(server, hash, bytes, signer, new AbortController().signal)).rejects.toThrow('too large')
})
