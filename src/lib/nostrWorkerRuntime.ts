import { createNostrRuntime, type NostrRuntimeOptions } from 'nostr-pubsub'
import { createEventStore } from './eventStore'
import { assertWorkerPublicationPolicy } from './workerPublicationPolicy'

/** The worker and restart recovery share the same durable admission boundary. */
export function createNostrWorkerRuntime(owner: string, signAuthEvent?: NostrRuntimeOptions['signAuthEvent']) {
  const runtime = createNostrRuntime({
    store: createEventStore(owner), batchWindowMs: 20, historyTimeoutMs: 5000, signAuthEvent,
  })
  const publish = runtime.publish.bind(runtime)
  runtime.publish = async (event, options = {}) => {
    assertWorkerPublicationPolicy(event)
    return publish(event, options)
  }
  return runtime
}
