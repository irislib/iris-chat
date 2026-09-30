import type { Event, EventTemplate } from 'nostr-tools'
import type { NostrRuntime, RuntimeSource, RuntimeRelayStats, RuntimeSubscriptionHandlers, RuntimeSubscribeOptions, NostrFilter } from 'nostr-pubsub'
import { serveNostrSource } from '@hashtree/worker/nostr-source-port'

/** The UI retains keys; one worker owns relay connections, verification, and durable indexes. */
export class NostrWorkerClient {
  private worker?: Worker
  private owner = 'public'
  private restartAttempts = 0
  private restartTimer?: ReturnType<typeof setTimeout>
  private nextId = 0
  private relays: readonly string[] = []
  private stats: RuntimeRelayStats[] = []
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly subscriptions = new Map<number, { filters: NostrFilter[]; handlers: RuntimeSubscriptionHandlers; options: RuntimeSubscribeOptions }>()
  private readonly sources = new Map<string, { source: RuntimeSource; close?: () => void }>()
  constructor(private readonly sign: (event: EventTemplate) => Promise<Event>) {}
  private start(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./nostrWorker.ts', import.meta.url), { type: 'module' })
    this.worker = worker
    worker.onmessage = async ({ data }) => {
      if (this.worker !== worker) return
      if (data.type === 'sign') {
        try { worker.postMessage({ method: 'signed', id: data.id, event: await this.sign(data.event) }) }
        catch (error) { worker.postMessage({ method: 'signed', id: data.id, error: String(error) }) }
      } else if (data.type === 'event') this.subscriptions.get(data.id)?.handlers.onEvent(data.event, data.info)
      else if (data.type === 'eose') this.subscriptions.get(data.id)?.handlers.onEose?.(data.status)
      else if (data.type === 'subscriptionError') this.subscriptions.get(data.id)?.handlers.onError?.(new Error(data.error))
      else if (data.type === 'result') this.pending.get(data.id)?.resolve(data.value)
      else if (data.type === 'error') this.pending.get(data.id)?.reject(new Error(data.error))
    }
    worker.onerror = () => {
      if (this.worker !== worker) return
      worker.terminate(); this.worker = undefined; this.stats = []
      for (const request of [...this.pending.values()]) request.reject(new Error('Message worker stopped'))
      // Recreate from durable state; active interests and the existing FIPS node survive.
      if (++this.restartAttempts <= 3) this.restartTimer = setTimeout(() => this.start(), 250 * this.restartAttempts)
      else for (const subscription of this.subscriptions.values()) subscription.handlers.onError?.(new Error('Message worker could not restart'))
    }
    worker.postMessage({ method: 'init', args: [this.owner] })
    worker.postMessage({ method: 'setRelays', args: [this.relays] })
    for (const [id, sub] of this.subscriptions) worker.postMessage({ id, method: 'subscribe', args: [sub.filters, sub.options] })
    for (const { source } of this.sources.values()) this.attachSource(source)
    return worker
  }
  private call<T>(method: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
    const worker = this.start(), id = ++this.nextId
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.pending.delete(id); signal?.removeEventListener('abort', abort) }
      const abort = () => { finish(); worker.postMessage({ method: 'cancel', args: [id] }); reject(new DOMException('Cancelled', 'AbortError')) }
      const timer = setTimeout(() => { finish(); reject(new Error('Message worker timed out')) }, 35_000)
      this.pending.set(id, { resolve: value => { finish(); resolve(value as T) }, reject: error => { finish(); reject(error) } })
      signal?.addEventListener('abort', abort, { once: true })
      try { worker.postMessage({ id, method, args }) }
      catch (error) { finish(); reject(error) }
    })
  }
  setAccount(owner = 'public') {
    if (owner === this.owner) return
    this.close(); this.owner = owner
  }
  setRelays(relays: readonly string[]) { this.relays = [...relays]; this.worker?.postMessage({ method: 'setRelays', args: [relays] }) }
  getRelayStats() {
    if (this.worker) void this.call<RuntimeRelayStats[]>('getRelayStats', []).then(stats => { this.stats = stats }).catch(() => {})
    return this.stats
  }
  query: NostrRuntime['query'] = (filters, options = {}) => {
    const { signal, ...serializable } = options
    return this.call('query', [filters, serializable], signal)
  }
  publish: NostrRuntime['publish'] = (event, options = {}) => this.call('publish', [event, options])
  subscribe: NostrRuntime['subscribe'] = (filters, handlers, options = {}) => {
    const worker = this.start(), id = ++this.nextId
    const { signal, ...serializable } = options
    const close = () => {
      this.subscriptions.delete(id); signal?.removeEventListener('abort', close)
      this.worker?.postMessage({ method: 'unsubscribe', args: [id] })
    }
    if (!signal?.aborted) {
      this.subscriptions.set(id, { filters, handlers, options: serializable })
      worker.postMessage({ id, method: 'subscribe', args: [filters, serializable] })
      signal?.addEventListener('abort', close, { once: true })
    }
    return { close }
  }
  private attachSource(source: RuntimeSource) {
    const entry = this.sources.get(source.id)!
    entry.close?.()
    const channel = new MessageChannel()
    entry.close = serveNostrSource(channel.port1, source)
    this.worker!.postMessage({ method: 'source', args: [source.id, source.publishAcceptance], port: channel.port2 }, [channel.port2])
  }
  addSource(source: RuntimeSource) {
    this.removeSource(source.id)
    this.start()
    this.sources.set(source.id, { source })
    this.attachSource(source)
  }
  removeSource(id: string) {
    this.sources.get(id)?.close?.(); this.sources.delete(id)
    this.worker?.postMessage({ method: 'source', args: [id] })
  }
  close() {
    clearTimeout(this.restartTimer); this.restartAttempts = 0; this.stats = []
    this.worker?.terminate(); this.worker = undefined
    for (const pending of [...this.pending.values()]) pending.reject(new Error('Message worker closed'))
    for (const source of this.sources.values()) source.close?.()
    this.sources.clear(); this.subscriptions.clear()
  }
}
