import {
  FipsNostrPubsubClient,
  type FipsNostrPubsubSubscription,
  type FipsPubsubClientNode,
} from 'nostr-pubsub'
import { matchFilter, type Filter, type VerifiedEvent } from 'nostr-tools'

const ALLOWED_RUNTIME_KINDS = [1059, 1060, 30078, 37368]

export type PubsubPeerSource = () => readonly string[]
export type PubsubEventHandler = (event: VerifiedEvent) => void

interface Subscription {
  filter: Filter
  onEvent: PubsubEventHandler
  seen: Set<string>
}

interface MeshInterest {
  filter: Filter
  subscribers: Set<Subscription>
  active?: FipsNostrPubsubSubscription
}

// Union only authors; every other constraint must match exactly. This preserves
// the original interests without advertising unrelated conversations to peers.
function meshInterests(subscriptions: Set<Subscription>): Map<string, MeshInterest> {
  const groups = new Map<string, { filter: Filter; authors?: Set<string>; subscribers: Set<Subscription> }>()
  for (const subscription of subscriptions) {
    const { authors, ...rest } = subscription.filter
    const filter = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))) as Filter
    const key = JSON.stringify([authors !== undefined, filter])
    let group = groups.get(key)
    if (!group) {
      group = { filter, authors: authors === undefined ? undefined : new Set(), subscribers: new Set() }
      groups.set(key, group)
    }
    for (const author of authors ?? []) group.authors!.add(author)
    group.subscribers.add(subscription)
  }
  const interests = new Map<string, MeshInterest>()
  for (const group of groups.values()) {
    const authors = group.authors && [...group.authors].sort()
    // Leave ample room below the carrier's 64 KiB frame bound.
    for (let offset = 0; offset < Math.max(1, authors?.length ?? 0); offset += 512) {
      const filter = authors ? { ...group.filter, authors: authors.slice(offset, offset + 512) } : group.filter
      interests.set(JSON.stringify(filter), { filter, subscribers: group.subscribers })
    }
  }
  return interests
}

/**
 * Live signed Nostr events over the shared authenticated nostr.pubsub/1
 * carrier. Relays still own initial contact and durable backfill.
 */
export class NostrPubsubRuntime {
  private readonly subscriptions = new Set<Subscription>()
  private readonly interests = new Map<string, MeshInterest>()
  private client: FipsNostrPubsubClient | null = null
  private reconcilePending = false

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
      // Merged author interests share one replay budget; retain access to the
      // whole bounded cache instead of only its last eight events.
      limits: { maxCachedEvents: 256, maxReplayEvents: 256 },
      onError: (error, context) => {
        console.warn(`[nostrPubsub] ${context.operation} failed:`, error)
      },
    }).start()
    this.client = client
    this.reconcile()
  }

  async deactivate(): Promise<void> {
    const client = this.client
    this.client = null
    this.interests.clear()
    await client?.stop()
  }

  subscribe(filter: Filter, onEvent: PubsubEventHandler): () => void {
    const subscription: Subscription = { filter: structuredClone(filter), onEvent, seen: new Set() }
    this.subscriptions.add(subscription)
    this.scheduleReconcile()
    return () => {
      if (!this.subscriptions.delete(subscription)) return
      this.scheduleReconcile()
    }
  }

  async publish(event: VerifiedEvent): Promise<void> {
    await this.client?.publish(event)
  }

  async idle(): Promise<void> {
    if (this.reconcilePending) {
      this.reconcilePending = false
      this.reconcile()
    }
    await this.client?.idle()
  }

  private scheduleReconcile(): void {
    if (this.reconcilePending) return
    this.reconcilePending = true
    queueMicrotask(() => {
      if (!this.reconcilePending) return
      this.reconcilePending = false
      this.reconcile()
    })
  }

  private reconcile(): void {
    if (!this.client) return
    const desired = meshInterests(this.subscriptions)
    for (const [key, interest] of this.interests) {
      if (desired.has(key)) continue
      interest.active?.close()
      this.interests.delete(key)
    }
    for (const [key, interest] of desired) {
      const existing = this.interests.get(key)
      if (existing) {
        const addedListener = [...interest.subscribers].some((subscription) => !existing.subscribers.has(subscription))
        if (!addedListener) {
          existing.subscribers = interest.subscribers
          continue
        }
        // A new listener still needs the carrier's cached history even when
        // its filter is already covered by the merged wire subscription.
        existing.active?.close()
        this.interests.delete(key)
      }
      try {
        interest.active = this.client.subscribe([interest.filter], (event) => {
          for (const subscription of interest.subscribers) {
            if (!this.subscriptions.has(subscription) || subscription.seen.has(event.id) || !matchFilter(subscription.filter, event)) continue
            try {
              subscription.onEvent(event)
              // Rebuilding a merged interest replays the carrier cache. Deliver
              // that history to new listeners without repeating it for old ones.
              subscription.seen.add(event.id)
              if (subscription.seen.size > 256) subscription.seen.delete(subscription.seen.values().next().value!)
            }
            catch (error) { console.warn('[nostrPubsub] event handler failed:', error) }
          }
        })
        this.interests.set(key, interest)
      } catch (error) {
        // A bounded mesh carrier must never prevent the independent relay
        // subscription from starting. Retry when the set of interests changes.
        console.warn('[nostrPubsub] subscription failed:', error)
      }
    }
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
