import { createIrisFipsPubsub, type IrisFipsMessagingEndpoint } from '@iris/nostr-pubsub'
import { matchFilter, type Filter, type VerifiedEvent } from 'nostr-tools'

const ALLOWED_RUNTIME_KINDS = new Set([1059, 1060, 30078, 37368])

export type PubsubPeerSource = () => readonly string[]
export type PubsubEventHandler = (event: VerifiedEvent) => void

interface Subscription {
  filter: Filter
  onEvent: PubsubEventHandler
}

/**
 * Live Nostr event path over an app-owned FIPS node. Relays remain responsible
 * for initial contact and durable backfill; this runtime owns neither.
 */
export class NostrPubsubRuntime {
  private readonly subscriptions = new Set<Subscription>()
  private adapter: ReturnType<typeof createIrisFipsPubsub> | null = null

  activate(endpoint: IrisFipsMessagingEndpoint, peers: PubsubPeerSource): void {
    this.deactivate()
    this.adapter = createIrisFipsPubsub({
      endpoint,
      peers,
      protocol: 'iris.chat.nostr',
      allowedKinds: ALLOWED_RUNTIME_KINDS,
      mesh: {
        fanout: 8,
        unknownPeerReserve: 2,
        maxCachedEvents: 256,
        maxCachedEventBytes: 4 * 1024 * 1024,
      },
      onError: (error, context) => {
        console.warn(`[nostrPubsub] ${context.operation} failed:`, error)
      },
    })
    this.adapter.subscribe(({ event }) => {
      for (const subscription of this.subscriptions) {
        if (!matchFilter(subscription.filter, event)) continue
        try {
          subscription.onEvent(event)
        } catch (error) {
          console.warn('[nostrPubsub] subscription callback failed:', error)
        }
      }
    })
  }

  deactivate(): void {
    this.adapter?.close()
    this.adapter = null
  }

  subscribe(filter: Filter, onEvent: PubsubEventHandler): () => void {
    const subscription = { filter: structuredClone(filter), onEvent }
    this.subscriptions.add(subscription)
    return () => this.subscriptions.delete(subscription)
  }

  async publish(event: VerifiedEvent): Promise<void> {
    await this.adapter?.publish(event)
  }

  async idle(): Promise<void> {
    await this.adapter?.idle()
  }
}

const runtime = new NostrPubsubRuntime()

export const activateNostrPubsub = (
  endpoint: IrisFipsMessagingEndpoint,
  peers: PubsubPeerSource,
): void => runtime.activate(endpoint, peers)

export const deactivateNostrPubsub = (): void => runtime.deactivate()

export const subscribeNostrPubsub = (
  filter: Filter,
  onEvent: PubsubEventHandler,
): (() => void) => runtime.subscribe(filter, onEvent)

export const publishNostrPubsub = (event: VerifiedEvent): Promise<void> =>
  runtime.publish(event)
