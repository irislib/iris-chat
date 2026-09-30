import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NostrWorkerClient } from './nostrWorkerClient'
import NostrClient, { SecretKeySigner } from './nostrClient'
import { generateSecretKey, verifyEvent } from 'nostr-tools'

class WorkerFixture {
  static instances: WorkerFixture[] = []
  messages: Array<Record<string, any>> = []
  onmessage?: (message: { data: Record<string, unknown> }) => void
  onerror?: () => void
  terminate = vi.fn()
  constructor() { WorkerFixture.instances.push(this) }
  postMessage(message: Record<string, unknown>) { this.messages.push(structuredClone(message)) }
  emit(data: Record<string, unknown>) { this.onmessage?.({ data }) }
}
const clients: NostrWorkerClient[] = []
beforeEach(() => { WorkerFixture.instances = []; vi.stubGlobal('Worker', WorkerFixture) })
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('keeps a restored secret key outside the event worker while signing relay authentication', async () => {
  const key = [...generateSecretKey()].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const app = new NostrClient({ explicitRelayUrls: ['wss://example.test'] })
  app.signer = new SecretKeySigner(key)
  clients.push(app.runtime)
  app.runtime.subscribe([{ kinds: [1] }], { onEvent() {} })
  const worker = WorkerFixture.instances[0]!
  worker.emit({ type: 'sign', id: 42, event: { kind: 22242, created_at: 1, tags: [['challenge', 'test']], content: '' } })
  await vi.waitFor(() => expect(worker.messages.some(message => message.method === 'signed')).toBe(true))
  const reply = worker.messages.find(message => message.method === 'signed')!
  expect(verifyEvent(reply.event)).toBe(true)
  expect(reply.event.pubkey).toBe(app.signer.pubkey)
  expect(JSON.stringify(worker.messages)).not.toContain(key)
})

it('replays live interests after a worker crash and ignores stale worker responses', async () => {
  vi.useFakeTimers()
  const client = new NostrWorkerClient(async () => { throw new Error('No signer') }); clients.push(client)
  const receive = vi.fn(), filters = [{ kinds: [1060], authors: ['a'.repeat(64)] }]
  client.subscribe(filters, { onEvent: receive }, { cache: 'network-only', localEcho: false, sources: [] })
  const first = WorkerFixture.instances[0]!, subscription = first.messages.find(message => message.method === 'subscribe')!
  first.onerror?.()
  await vi.advanceTimersByTimeAsync(250)
  const second = WorkerFixture.instances[1]!
  expect(second.messages.find(message => message.method === 'subscribe')?.args).toEqual(subscription.args)
  first.emit({ type: 'event', id: subscription.id, event: { content: 'stale' } })
  expect(receive).not.toHaveBeenCalled()
  second.emit({ type: 'event', id: subscription.id, event: { content: 'current' } })
  expect(receive).toHaveBeenCalledOnce()
})

it('switches account storage without retaining old private interests or pending requests', async () => {
  const client = new NostrWorkerClient(async () => { throw new Error('No signer') }); clients.push(client)
  client.setAccount('first')
  client.subscribe([{ kinds: [1060] }], { onEvent() {} })
  const query = client.query([{ kinds: [37368] }])
  const rejected = expect(query).rejects.toThrow('Message worker closed')
  const first = WorkerFixture.instances[0]!
  client.setAccount('second')
  await rejected
  client.subscribe([{ kinds: [0] }], { onEvent() {} })
  const second = WorkerFixture.instances[1]!
  expect(first.terminate).toHaveBeenCalledOnce()
  expect(second.messages.find(message => message.method === 'init')?.args).toEqual(['second'])
  expect(second.messages.filter(message => message.method === 'subscribe').map(message => message.args[0])).toEqual([[{ kinds: [0] }]])
})
