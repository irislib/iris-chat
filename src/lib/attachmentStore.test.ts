// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { HashTree, sha256, toHex, nhashEncode, nhashDecode } from '@hashtree/core'
import { DexieStore } from '@hashtree/dexie'
import { AttachmentStore } from './attachmentStore'
const owner = 'a'.repeat(64), server = 'https://files.example'
const stores: AttachmentStore[] = []
function create(limit = 1024, name = crypto.randomUUID(), now?: () => number) { const store = new AttachmentStore(name, limit, now); stores.push(store); return store }
afterEach(async () => { for (const store of stores.splice(0)) { store.close(); await store.db.delete() } })
async function stage(store: AttachmentStore, bytes: Uint8Array, servers = [server]) {
  const id = await store.begin(owner, servers)
  const result = await new HashTree({ store: store.writer(id), chunkSize: 64 }).putFile(bytes)
  const nhash = nhashEncode(result.cid)
  await store.finish(id, nhash, result.cid.hash)
  return { id, nhash, root: toHex(result.cid.hash) }
}
it('pins every encrypted chunk and root across restart and rejects quota without losing an accepted file', async () => {
  const name = crypto.randomUUID(), bytes = new Uint8Array(140).fill(17), store = create(500, name)
  const file = await stage(store, bytes)
  const used = await store.stats(); expect(used.blocks).toBeGreaterThan(1)
  const second = await store.begin(owner, [server])
  await expect(new HashTree({ store: store.writer(second), chunkSize: 64 }).putFile(new Uint8Array(400).fill(83))).rejects.toThrow('storage is full')
  await store.abort(second)
  expect(await store.stats()).toEqual(used)
  store.close(); const reopened = create(500, name)
  expect(await new HashTree({ store: reopened }).readFile(nhashDecode(file.nhash))).toEqual(bytes)
  expect((await reopened.claim(owner, 'lease'))?.blocks.length).toBe(used.blocks)
})
it('evicts recoverable LRU blocks, protects active reads, and releases abandoned staging pins', async () => {
  let time = 1
  const store = create(64, undefined, () => time++)
  const a = new Uint8Array(32).fill(1), b = new Uint8Array(32).fill(2), c = new Uint8Array(32).fill(3)
  const ah = await sha256(a), bh = await sha256(b), ch = await sha256(c)
  await store.put(ah, a); await store.put(bh, b)
  const read = await store.begin(owner, [server], true)
  await store.writer(read).put(ah, a)
  await store.put(ch, c)
  expect(await store.has(ah)).toBe(true); expect(await store.has(bh)).toBe(false)
  await store.abort(read)
  const writing = await store.begin(owner, [server]); await store.writer(writing).put(bh, b)
  await store.abort(writing)
  expect((await store.stats()).files).toBe(0)
  expect(await store.has(bh)).toBe(false)
})
it('only records complete-tree per-server receipts and releases pending pins after one complete server', async () => {
  const store = create(900), file = await stage(store, new Uint8Array(140).fill(23), [server, 'https://other.example'])
  let job = (await store.claim(owner, 'lease'))!
  expect(await store.claim('b'.repeat(64), 'other')).toBeUndefined()
  await store.acknowledge(file.id, 'wrong', server, 0)
  expect((await store.receipts(owner, [file.nhash]))[0]!.uploadedUrls).toEqual([])
  for (let i = 0; i < job.blocks.length; i++) {
    if (i) job = (await store.claim(owner, 'lease'))!
    await store.acknowledge(file.id, 'lease', server, i)
    if (i + 1 < job.blocks.length) expect((await store.receipts(owner, [file.nhash]))[0]!.uploadedUrls).toEqual([])
  }
  expect((await store.receipts(owner, [file.nhash]))[0]!.uploadedUrls).toEqual([`${server}/${file.root}.bin`])
  expect(await store.delete(nhashDecode(file.nhash).hash)).toBe(true)
  expect(await store.receipts('b'.repeat(64), [file.nhash])).toEqual([])
  await store.db.table('files').update(file.id, { uploadedUrls: ['javascript:alert(1)', `${server}/${file.root}.bin?key=secret`, `https://other.example/${file.root}.bin`] })
  expect((await store.receipts(owner, [file.nhash]))[0]!.uploadedUrls).toEqual([])
})
it('preserves and counts legacy possible-only copies during migration', async () => {
  const name = crypto.randomUUID(), legacy = new DexieStore(name), bytes = new Uint8Array(90).fill(4), hash = await sha256(bytes)
  expect(await legacy.put(hash, bytes)).toBe(true); legacy.close()
  const store = create(64, name)
  expect(await store.get(hash)).toEqual(bytes)
  expect((await store.stats()).bytes).toBe(90)
  await expect(store.put(await sha256(new Uint8Array(2)), new Uint8Array(2))).rejects.toThrow('storage is full')
  expect(await store.delete(hash)).toBe(false)
})
it('cleans an expired interrupted writer without deleting committed pending trees', async () => {
  let now = 0; const store = create(1024, undefined, () => now)
  const kept = await stage(store, new Uint8Array(10).fill(4))
  const interrupted = await store.begin(owner, [server]); const bytes = new Uint8Array(20).fill(5), hash = await sha256(bytes)
  await store.writer(interrupted).put(hash, bytes)
  now = 70_000
  await store.claim(owner, 'lease')
  expect(await store.has(hash)).toBe(false)
  expect(await new HashTree({ store }).readFile(nhashDecode(kept.nhash))).toEqual(new Uint8Array(10).fill(4))
  await expect(store.writer(interrupted).put(hash, bytes)).rejects.toThrow('canceled')
})

it('expires only abandoned drafts and preserves explicitly retained message attachments across restart', async () => {
  let now = 1; const name = crypto.randomUUID(), store = create(1024, name, () => now)
  const makeDraft = async (value: number) => {
    const id = await store.begin(owner, [server]), bytes = new Uint8Array(20).fill(value)
    const result = await new HashTree({ store: store.writer(id) }).putFile(bytes)
    const nhash = nhashEncode(result.cid)
    await store.finish(id, nhash, result.cid.hash, true)
    return { id, nhash, hash: result.cid.hash }
  }
  const abandoned = await makeDraft(7), sent = await makeDraft(8), active = await makeDraft(9)
  await store.retain(sent.id)
  now += 40_000; await store.renewDraft(active.id)
  now += 30_000; await store.claim(owner, 'worker')
  expect(await store.has(abandoned.hash)).toBe(false)
  expect(await store.has(sent.hash)).toBe(true); expect(await store.has(active.hash)).toBe(true)
  store.close(); now += 100_000
  const reopened = create(1024, name, () => now)
  await reopened.claim(owner, 'restart')
  expect(await reopened.has(active.hash)).toBe(false)
  expect(await new HashTree({ store: reopened }).readFile(nhashDecode(sent.nhash))).toEqual(new Uint8Array(20).fill(8))
  expect((await reopened.stats()).files).toBe(1)
})
