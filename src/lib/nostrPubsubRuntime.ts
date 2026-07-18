import {
  FipsNostrPubsubClient,
  type FipsNostrPubsubSubscription,
  type FipsPubsubClientNode,
} from 'nostr-pubsub'
import type { Filter, VerifiedEvent } from 'nostr-tools'

const ALLOWED_RUNTIME_KINDS = [1059, 1060, 30078, 37368]

export type PubsubPeerSource = () => readonly string[]
export type PubsubEventHandler = (event: VerifiedEvent) => void

interface Subscription {
  filter: Filter
  onEvent: PubsubEventHandler
  active?: FipsNostrPubsubSubscription
}

/**
 * Live signed Nostr events over the shared authenticated nostr.pubsub/1
 * carrier. Relays still own initial contact and durable backfill.
 */
export class NostrPubsubRuntime {
  private readonly subscriptions = new Set<Subscription>()
  private client: FipsNostrPubsubClient | null = null

  async activate(
    node: FipsPubsubClientNode,
    localPeerId: string,
    peers: PubsubPeerSource,
  ): Promise<void> {
    await this.deactivate()
    const client = new FipsNostrPubsubClient({
      node,
      localPeerId,
      peers,
      allowedKinds: ALLOWED_RUNTIME_KINDS,
      limits: { maxCachedEvents: 256 },
      onError: (error, context) => {
        console.warn(`[nostrPubsub] ${context.operation} failed:`, error)
      },
    }).start()
    this.client = client
    try {
      for (const subscription of this.subscriptions) this.attach(subscription)
    } catch (error) {
      this.client = null
      await client.stop()
      throw error
    }
  }

  async deactivate(): Promise<void> {
    const client = this.client
    this.client = null
    for (const subscription of this.subscriptions) subscription.active = undefined
    await client?.stop()
  }

  subscribe(filter: Filter, onEvent: PubsubEventHandler): () => void {
    const subscription: Subscription = { filter: structuredClone(filter), onEvent }
    this.subscriptions.add(subscription)
    this.attach(subscription)
    return () => {
      if (!this.subscriptions.delete(subscription)) return
      subscription.active?.close()
      subscription.active = undefined
    }
  }

  async publish(event: VerifiedEvent): Promise<void> {
    await this.client?.publish(event)
  }

  async idle(): Promise<void> {
    await this.client?.idle()
  }

  private attach(subscription: Subscription): void {
    subscription.active = this.client?.subscribe(
      [subscription.filter],
      (event) => subscription.onEvent(event),
    )
  }
}

const runtime = new NostrPubsubRuntime()

export const activateNostrPubsub = (
  node: FipsPubsubClientNode,
  localPeerId: string,
  peers: PubsubPeerSource,
): Promise<void> => runtime.activate(node, localPeerId, peers)

export const deactivateNostrPubsub = (): Promise<void> => runtime.deactivate()

export const subscribeNostrPubsub = (
  filter: Filter,
  onEvent: PubsubEventHandler,
): (() => void) => runtime.subscribe(filter, onEvent)

export const publishNostrPubsub = (event: VerifiedEvent): Promise<void> =>
  runtime.publish(event)
