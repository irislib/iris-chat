import Dexie, { type Table } from 'dexie'
import { toHex, sha256, type Hash, type Store } from '@hashtree/core'

export const ATTACHMENT_CACHE_BYTES = 1024 * 1024 * 1024
const MAX_BLOCKS = 8192, MAX_FILES = 1024, MAX_FILE_BLOCKS = 256, MAX_READERS = 16, LEASE_MS = 60_000
interface Block { hashHex: string; data: Uint8Array; lastAccess: number }
interface Access { hashHex: string; size: number; lastAccess: number; pins: number; safe: number; legacy?: boolean }
interface Usage { key: string; bytes: number; blocks: number }
export interface AttachmentRecord {
  id: string; owner: string; nhash?: string; root?: string; blocks: string[]
  servers: { url: string; acknowledged: number; retryAt: number; failures: number }[]; uploadedUrls: string[]
  reader?: boolean; draftUntil?: number; state: 'writing' | 'pending' | 'done'; created: number; leaseUntil: number
  token?: string; released: boolean
}
export function attachmentServerUrl(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.length > 2048) throw new Error('Invalid file server')
  return url.href.replace(/\/+$/, '')
}

/** Ciphertext and its eviction/replication journal share one IndexedDB transaction. */
export class AttachmentStore implements Store {
  readonly db: Dexie
  private blobs: Table<Block, string>
  private accesses: Table<Access, string>
  private files: Table<AttachmentRecord, string>
  private usage: Table<Usage, string>
  constructor(name = 'iris-chat-attachments', readonly limit = ATTACHMENT_CACHE_BYTES, private now = Date.now) {
    this.db = new Dexie(name)
    this.db.version(3).stores({ blobs: '&hashHex,lastAccess', accesses: '&hashHex,lastAccess' })
    this.db.version(4).stores({ blobs: '&hashHex,lastAccess', accesses: '&hashHex,lastAccess,safe', files: '&id,owner,created,state', usage: '&key' }).upgrade(async tx => {
      let bytes = 0, blocks = 0
      // An old cached block may be its only copy. Never guess that it is recoverable.
      let after = ''
      while (true) {
        const blob = await tx.table('blobs').where('hashHex').above(after).first() as Block | undefined
        if (!blob) break
        bytes += blob.data.byteLength; blocks++; after = blob.hashHex
        await tx.table('accesses').put({ hashHex: blob.hashHex, size: blob.data.byteLength, lastAccess: blob.lastAccess || this.now(), pins: 0, safe: 0, legacy: true })
      }
      await tx.table('usage').put({ key: 'total', bytes, blocks })
    })
    this.blobs = this.db.table('blobs'); this.accesses = this.db.table('accesses')
    this.files = this.db.table('files'); this.usage = this.db.table('usage')
  }
  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.db.transaction('rw', [this.blobs, this.accesses, this.files, this.usage], operation)
  }
  private async totals() { return await this.usage.get('total') ?? { key: 'total', bytes: 0, blocks: 0 } }
  private async removeBlock(hash: string, total: Usage) {
    const meta = await this.accesses.get(hash)
    if (!meta) return
    await this.blobs.delete(hash); await this.accesses.delete(hash)
    total.bytes -= meta.size; total.blocks--
  }
  private async makeRoom(bytes: number, extra: number, total: Usage) {
    while (total.bytes + bytes > this.limit || total.blocks + extra > MAX_BLOCKS) {
      const victim = await this.accesses.orderBy('lastAccess').filter(row => row.safe === 1 && row.pins === 0).first()
      if (!victim) throw new Error('Attachment storage is full. Free space before adding another file.')
      await this.removeBlock(victim.hashHex, total)
    }
  }
  private async write(hash: Hash, data: Uint8Array, id?: string): Promise<boolean> {
    if (toHex(await sha256(data)) !== toHex(hash)) throw new Error('Attachment hash mismatch')
    return this.transaction(async () => {
      const file = id ? await this.files.get(id) : undefined
      if (id && (!file || file.state !== 'writing' || file.leaseUntil < this.now())) throw new Error('Attachment was canceled')
      const hex = toHex(hash), total = await this.totals()
      let meta = await this.accesses.get(hex)
      if (!meta) {
        await this.makeRoom(data.byteLength, 1, total)
        meta = { hashHex: hex, size: data.byteLength, lastAccess: this.now(), pins: 0, safe: file && !file.reader ? 0 : 1 }
        await this.blobs.put({ hashHex: hex, data, lastAccess: this.now() })
        total.bytes += data.byteLength; total.blocks++
      }
      if (file && !file.blocks.includes(hex)) {
        if (file.blocks.length >= MAX_FILE_BLOCKS) throw new Error('Attachment has too many chunks')
        file.blocks.push(hex); meta.pins++
      }
      meta.lastAccess = this.now()
      await this.accesses.put(meta); await this.usage.put(total)
      if (file) { file.leaseUntil = this.now() + LEASE_MS; await this.files.put(file) }
      return true
    })
  }
  put(hash: Hash, data: Uint8Array) { return this.write(hash, data) }
  async get(hash: Hash) {
    return this.db.transaction('rw', this.blobs, this.accesses, async () => {
      const hex = toHex(hash), block = await this.blobs.get(hex)
      if (!block) return null
      await this.accesses.update(hex, { lastAccess: this.now() })
      return block.data
    })
  }
  async has(hash: Hash) { return !!await this.accesses.get(toHex(hash)) }
  async delete(hash: Hash) {
    return this.transaction(async () => {
      const hex = toHex(hash), meta = await this.accesses.get(hex)
      if (!meta || meta.pins || !meta.safe) return false
      const total = await this.totals(); await this.removeBlock(hex, total); await this.usage.put(total); return true
    })
  }
  async begin(owner: string, servers: string[], reader = false) {
    if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error('Not logged in')
    const urls = [...new Set(servers.map(attachmentServerUrl))]
    if (!urls.length || urls.length > 8) throw new Error('Invalid file servers')
    return this.transaction(async () => {
      await this.clearExpiredWrites()
      if (reader && await this.files.filter(row => !!row.reader).count() >= MAX_READERS) throw new Error('Too many attachments are loading')
      while (!reader && await this.files.filter(row => !row.reader).count() >= MAX_FILES) {
        const oldest = await this.files.orderBy('created').filter(row => row.state === 'done' && !row.draftUntil).first()
        if (!oldest) throw new Error('Too many pending attachments')
        await this.files.delete(oldest.id)
      }
      const id = crypto.randomUUID()
      await this.files.put({ id, owner, reader, blocks: [], servers: urls.map(url => ({ url, acknowledged: 0, retryAt: 0, failures: 0 })), uploadedUrls: [], state: 'writing', created: this.now(), leaseUntil: this.now() + LEASE_MS, released: false })
      return id
    })
  }
  writer(id: string): Store {
    return { get: hash => this.get(hash), has: hash => this.has(hash), delete: hash => this.delete(hash), put: (hash, bytes) => this.write(hash, bytes, id) }
  }
  async finish(id: string, nhash: string, root: Hash, staged = false) {
    await this.transaction(async () => {
      const file = await this.files.get(id)
      if (!file || file.state !== 'writing' || !file.blocks.includes(toHex(root)) || file.leaseUntil < this.now()) throw new Error('Attachment was canceled')
      for (const hash of file.blocks) if (!await this.blobs.where('hashHex').equals(hash).count()) throw new Error('Attachment could not be stored')
      Object.assign(file, { nhash, root: toHex(root), state: 'pending', leaseUntil: 0, ...(staged && { draftUntil: this.now() + LEASE_MS }) })
      await this.files.put(file)
    })
  }
  async retain(id: string) {
    // Commit before message publication. Later send failures can be ambiguous, so
    // retained trees never expire as drafts; they count against the bounded quota
    // until a complete remote copy makes their blocks safely evictable.
    await this.transaction(async () => {
      const file = await this.files.get(id)
      if (!file || file.state === 'writing' || (file.draftUntil !== undefined && file.draftUntil < this.now())) throw new Error('Attachment was canceled')
      delete file.draftUntil
      await this.files.put(file)
    })
  }
  async renewDraft(id: string) {
    await this.transaction(async () => {
      const file = await this.files.get(id)
      if (file?.draftUntil !== undefined) { file.draftUntil = this.now() + LEASE_MS; await this.files.put(file) }
    })
  }
  private async releasePins(file: AttachmentRecord, safe: boolean) {
    const total = await this.totals()
    if (!file.released) for (const hash of file.blocks) {
      const meta = await this.accesses.get(hash)
      if (!meta) continue
      meta.pins = Math.max(0, meta.pins - 1)
      if (safe) meta.safe = 1
      if (!safe && !meta.pins && !meta.safe && !meta.legacy) await this.removeBlock(hash, total)
      else await this.accesses.put(meta)
    }
    file.released = true
    await this.usage.put(total)
  }
  async abort(id: string, pending = false) {
    await this.transaction(async () => {
      const file = await this.files.get(id)
      if (!file || (file.state !== 'writing' && !pending)) return
      await this.releasePins(file, false); await this.files.delete(id)
    })
  }
  private async clearExpiredWrites() {
    for (const file of await this.files.filter(row => (row.state === 'writing' && row.leaseUntil < this.now()) || (row.draftUntil !== undefined && row.draftUntil < this.now())).toArray()) {
      await this.releasePins(file, false); await this.files.delete(file.id)
    }
  }
  async claim(owner: string, token: string): Promise<AttachmentRecord | undefined> {
    return this.transaction(async () => {
      await this.clearExpiredWrites()
      const file = await this.files.where('owner').equals(owner).filter(row => row.state === 'pending' && row.servers.some(server => server.acknowledged < row.blocks.length && server.retryAt <= this.now()) && row.leaseUntil <= this.now()).first()
      if (!file) return
      file.token = token; file.leaseUntil = this.now() + LEASE_MS; await this.files.put(file); return file
    })
  }
  async acknowledge(id: string, token: string, server: string, index: number) {
    await this.transaction(async () => {
      const file = await this.files.get(id)
      if (!file || file.token !== token || file.leaseUntil < this.now()) return
      const destination = file.servers.find(row => row.url === server)
      if (!destination || destination.acknowledged !== index) return
      destination.acknowledged++; destination.retryAt = 0; destination.failures = 0
      if (destination.acknowledged === file.blocks.length) {
        file.uploadedUrls = [...new Set([...file.uploadedUrls, `${server}/${file.root}.bin`])]
        await this.releasePins(file, true)
      }
      if (file.servers.every(row => row.acknowledged === file.blocks.length)) file.state = 'done'
      file.leaseUntil = 0; delete file.token
      await this.files.put(file)
    })
  }
  async retry(id: string, token: string, failed: boolean, server?: string) {
    await this.transaction(async () => {
      const file = await this.files.get(id)
      if (!file || file.token !== token) return
      const destination = file.servers.find(row => row.url === server)
      if (failed && destination) { destination.failures = Math.min(16, destination.failures + 1); destination.retryAt = this.now() + Math.min(300_000, 5000 * 2 ** (destination.failures - 1)) }
      file.leaseUntil = 0; delete file.token; await this.files.put(file)
    })
  }
  nowMillis() { return this.now() }
  async receipts(owner: string, nhashes: string[]) {
    const wanted = new Set(nhashes)
    return (await this.files.where('owner').equals(owner).filter(row => !!row.nhash && wanted.has(row.nhash)).toArray())
      .map(row => ({ nhash: row.nhash!, uploadedUrls: row.servers.flatMap(server => {
        if (!row.root || !/^[a-f0-9]{64}$/.test(row.root) || !row.blocks.length || server.acknowledged !== row.blocks.length) return []
        try {
          const url = `${attachmentServerUrl(server.url)}/${row.root}.bin`
          return row.uploadedUrls.includes(url) ? [url] : []
        } catch { return [] }
      }) }))
  }
  async stats() { return { ...await this.totals(), files: await this.files.count() } }
  close() { this.db.close() }
}
