import { BlossomStore, fromHex, sha256, toHex, type BlossomSigner } from '@hashtree/core'
import { AttachmentStore, attachmentServerUrl } from './attachmentStore'

/** Abortable BUD-02 upload. Only a response for this exact ciphertext is an acknowledgement. */
export async function uploadEncryptedBlock(server: string, hash: string, bytes: Uint8Array, signer: BlossomSigner, signal: AbortSignal) {
  const url = attachmentServerUrl(server)
  if (signal.aborted || toHex(await sha256(bytes)) !== hash) throw new Error('Attachment upload canceled')
  const now = Math.floor(Date.now() / 1000)
  if (signal.aborted) throw new Error('Attachment upload canceled')
  let abort!: () => void
  const canceled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Attachment upload canceled')); signal.addEventListener('abort', abort, { once: true }) })
  let signed
  try { signed = await Promise.race([signer({ kind: 24242, created_at: now, content: `upload ${hash}`, tags: [['t', 'upload'], ['x', hash], ['expiration', String(now + 300)]] }), canceled]) }
  finally { signal.removeEventListener('abort', abort) }
  if (signal.aborted) throw new Error('Attachment upload canceled')
  const response = await fetch(`${url}/upload`, { method: 'PUT', body: new Blob([bytes as BlobPart]), signal,
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    headers: { Authorization: `Nostr ${btoa(JSON.stringify(signed))}`, 'Content-Type': 'application/octet-stream', 'X-SHA-256': hash } })
  if (!response.ok) throw new Error('File server did not acknowledge the upload')
  // BUD-02 returns a blob descriptor. Ambiguous/partial/conflicting responses cannot unpin a tree.
  const reader = response.body?.getReader()
  if (!reader) throw new Error('File server returned no acknowledgement')
  const chunks: Uint8Array[] = []; let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 16 * 1024) throw new Error('File server acknowledgement is too large')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const body = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length }
  const descriptor = JSON.parse(new TextDecoder().decode(body))
  if (descriptor.sha256 !== hash || (descriptor.size !== undefined && descriptor.size !== bytes.byteLength)) throw new Error('File server returned a different attachment')
}

/** One bounded job and request at a time; the journal owns retries across reloads. */
export class AttachmentReplication {
  private stopped = false
  private requested = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<boolean> | undefined
  private controller: AbortController | undefined
  private readonly token = crypto.randomUUID()
  constructor(private store: AttachmentStore, private owner: string, private signer: BlossomSigner,
    private current: () => boolean, private changed: () => void = () => {}) {}

  wake() {
    if (this.stopped || !this.current()) return
    clearTimeout(this.timer); this.timer = undefined
    if (this.running) { this.requested = true; return }
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.step().then(worked => {
        const again = worked || this.requested; this.requested = false
        this.schedule(again ? 0 : 5000)
      }).catch(() => this.schedule(5000))
    }, 0)
  }
  private schedule(delay: number) {
    if (this.stopped || !this.current()) return
    this.timer = setTimeout(() => { this.timer = undefined; this.wake() }, delay)
  }
  step(): Promise<boolean> {
    if (this.running) return this.running
    const job = this.process()
    this.running = job
    void job.finally(() => { if (this.running === job) this.running = undefined }).catch(() => {})
    return job
  }
  private async process(): Promise<boolean> {
    if (this.stopped || !this.current()) return false
    const file = await this.store.claim(this.owner, this.token)
    if (!file) return false
    const server = file.servers.find(row => row.acknowledged < file.blocks.length && row.retryAt <= this.store.nowMillis())
    if (!server) { await this.store.retry(file.id, this.token, true); return false }
    const hash = file.blocks[server.acknowledged]!
    const controller = new AbortController(); this.controller = controller
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      if (this.stopped || !this.current()) throw new Error('Account changed')
      let bytes = await this.store.get(fromHex(hash))
      if (!bytes && file.uploadedUrls.length) {
        const recovered = new BlossomStore({ servers: file.servers.filter(row => row.acknowledged === file.blocks.length).map(row => row.url), getTimeoutMs: 10_000 })
        bytes = await recovered.get(fromHex(hash))
      }
      if (!bytes || this.stopped || !this.current()) throw new Error('Attachment unavailable locally')
      await uploadEncryptedBlock(server.url, hash, bytes, this.signer, controller.signal)
      if (this.stopped || !this.current()) throw new Error('Account changed')
      await this.store.acknowledge(file.id, this.token, server.url, server.acknowledged)
      this.changed()
    } catch {
      await this.store.retry(file.id, this.token, !this.stopped && this.current(), server.url)
    } finally {
      clearTimeout(timeout); controller.abort()
      if (this.controller === controller) this.controller = undefined
    }
    return true
  }
  stop() {
    this.stopped = true
    clearTimeout(this.timer); this.timer = undefined
    this.controller?.abort()
  }
}
