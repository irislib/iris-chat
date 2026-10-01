import type { NostrEvent } from 'nostr-pubsub'
import type { RuntimeSubscription } from 'nostr-pubsub'
import { connectNostrSource } from '@hashtree/worker/nostr-source-port'
import { createNostrWorkerRuntime } from './nostrWorkerRuntime'

const subscriptions = new Map<number, RuntimeSubscription>()
const queries = new Map<number, AbortController>()
const sources = new Map<string, ReturnType<typeof connectNostrSource>>()
const signing = new Map<number, { resolve: (event: NostrEvent) => void; reject: (error: Error) => void }>()
let nextSign = 0
const createRuntime = (owner: string) => createNostrWorkerRuntime(owner,
  (_relay, event) => new Promise((resolve, reject) => {
    const id = ++nextSign
    const timer = setTimeout(() => { signing.delete(id); reject(new Error('Signing timed out')) }, 30_000)
    signing.set(id, { resolve: event => { clearTimeout(timer); signing.delete(id); resolve(event) },
      reject: error => { clearTimeout(timer); signing.delete(id); reject(error) } })
    self.postMessage({ type: 'sign', id, event })
  }))
let runtime: ReturnType<typeof createRuntime>
self.onmessage = async ({ data }) => {
  const { id, method, args = [] } = data
  if (method === 'init') { runtime = createRuntime(args[0]); return }
  if (method === 'signed') {
    if (data.error) signing.get(id)?.reject(new Error(data.error))
    else signing.get(id)?.resolve(data.event)
    return
  }
  try {
    let value: unknown
    switch (method) {
      case 'setRelays': runtime.setRelays(args[0]); break
      case 'getRelayStats': value = runtime.getRelayStats(); break
      case 'query': {
        const controller = new AbortController(); queries.set(id, controller)
        try { value = await runtime.query(args[0], { ...args[1], signal: controller.signal }) }
        finally { queries.delete(id) }
        break
      }
      case 'cancel': queries.get(args[0])?.abort(); return
      case 'publish': value = await runtime.publish(args[0], args[1]); break
      case 'subscribe':
        subscriptions.set(id, runtime.subscribe(args[0], {
          onEvent: (event, info) => self.postMessage({ id, type: 'event', event, info }),
          onEose: status => self.postMessage({ id, type: 'eose', status }),
          onError: error => self.postMessage({ id, type: 'subscriptionError', error: error.message }),
        }, args[1]))
        return
      case 'unsubscribe': subscriptions.get(args[0])?.close(); subscriptions.delete(args[0]); return
      case 'source': {
        runtime.removeSource(args[0]); sources.get(args[0])?.close(); sources.delete(args[0])
        if (data.port) {
          const connection = connectNostrSource(data.port, args[0], args[1])
          sources.set(args[0], connection); runtime.addSource(connection.source)
        }
        break
      }
      default: throw new Error(`Unknown event operation: ${method}`)
    }
    self.postMessage({ id, type: 'result', value })
  } catch (error) {
    self.postMessage({ id, type: 'error', error: String(error) })
  }
}
