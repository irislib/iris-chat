import { BlossomStore } from '@hashtree/core'
import { createSigner } from './hashtree'
import { encodeInviteRecord, decodeInviteRecord, decodeInviteReference, MAX_INVITE_BYTES, type InviteRecord } from './inviteRecord'

const readServers = ['https://cdn.iris.to', 'https://upload.iris.to']
export async function publishInviteRecord(record: InviteRecord): Promise<string> {
  const { reference, ciphertext } = await encodeInviteRecord(record)
  let acknowledged = false
  const store = new BlossomStore({ servers: [{ url: 'https://upload.iris.to', write: true, read: false }],
    signer: createSigner(), putTimeoutMs: 15000, skipExistenceCheck: true,
    onUploadProgress: (_server, status) => { if (status !== 'failed') acknowledged = true } })
  // A shareable link requires acknowledged remote storage, not only a local cache.
  await store.put(decodeInviteReference(reference).hash, ciphertext)
  if (!acknowledged) throw new Error('Could not upload invite. Try again.')
  return reference
}

const previews = new Map<string, Promise<InviteRecord>>()
export function loadInviteRecord(reference: string): Promise<InviteRecord> {
  let pending = previews.get(reference)
  if (!pending) {
    if (previews.size >= 8) previews.delete(previews.keys().next().value!)
    pending = fetchInviteRecord(reference).catch(error => { previews.delete(reference); throw error })
    previews.set(reference, pending)
  }
  return pending
}
async function fetchInviteRecord(reference: string): Promise<InviteRecord> {
  const { hash } = decodeInviteReference(reference)
  const hex = Array.from(hash, b => b.toString(16).padStart(2, '0')).join('')
  for (const server of readServers) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(`${server}/${hex}`, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' })
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_INVITE_BYTES) continue
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []; let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > MAX_INVITE_BYTES) throw new Error('Invite is too large')
          chunks.push(value)
        }
      } finally { await reader.cancel() }
      const data = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
      return await decodeInviteRecord(reference, data)
    } catch { /* Try the other established blob server; never use a record-supplied URL. */ }
    finally { clearTimeout(timeout); controller.abort() }
  }
  throw new Error('Could not load invite. Check your connection and try again.')
}
