import { expect } from '@playwright/test'

type Event = { id: string; kind: number; pubkey: string; tags: string[][] }
type Filter = { kinds?: number[]; authors?: string[]; [key: string]: unknown }

/** Inspect the actual relay serialization, independently of protocol decryption. */
export class PrivateGroupWire {
  private readonly subscriptions = new Map<number, Filter[]>()
  private readonly authentication = new Map<number, string>()
  private readonly events: Array<{ connection: number; event: Event }> = []

  observe = (message: unknown[], connection: number) => {
    if (message[0] === 'AUTH') this.authentication.set(connection, (message[1] as Event).pubkey)
    if (message[0] === 'REQ') {
      const filters = this.subscriptions.get(connection) ?? []
      filters.push(...message.slice(2) as Filter[])
      this.subscriptions.set(connection, filters)
    }
    if (message[0] === 'EVENT') this.events.push({ connection, event: message[1] as Event })
  }

  assertPrivate(identities: string[], sharedGroupAuthors: string[] = []) {
    const privateEvents = this.events.filter(({ event }) => [1059, 1060, 21111].includes(event.kind))
    expect(privateEvents.length).toBeGreaterThan(0)
    const privateConnections = new Set(privateEvents.map(({ connection }) => connection))
    const keys = new Set(identities)
    for (const { event } of this.events) {
      expect(event.kind === 37368 && event.tags.some(tag => tag[0] === 'type' && tag[1] === 'group_roster')).toBe(false)
      expect([10445, 10446, 10447, 21113]).not.toContain(event.kind)
      if (event.kind === 37368) for (const tag of event.tags) {
        if (['p', 'device'].includes(tag[0]!) && /^[a-f0-9]{64}$/.test(tag[1] ?? '')) keys.add(tag[1]!)
      }
    }
    const authenticationKeys: string[] = []
    for (const connection of privateConnections) {
      expect(this.subscriptions.get(connection) ?? []).toEqual([])
      const authentication = this.authentication.get(connection)
      expect(authentication).toMatch(/^[a-f0-9]{64}$/)
      expect(keys.has(authentication!)).toBe(false)
      authenticationKeys.push(authentication!)
      expect(new Set(privateEvents.filter(item => item.connection === connection).map(({ event }) => event.id)).size).toBe(1)
    }
    expect(new Set(authenticationKeys).size).toBe(privateConnections.size)
    for (const { event } of privateEvents) {
      expect(keys.has(event.pubkey)).toBe(false)
      expect(event.tags.filter(tag => tag[0] === 'p')).toHaveLength(1)
      if (event.kind === 1060) expect(event.tags).toContainEqual(['v', '2'])
    }
    const groupAuthors = new Set(sharedGroupAuthors)
    for (const filters of this.subscriptions.values()) for (const filter of filters) {
      expect((filter['#type'] as string[] | undefined) ?? []).not.toContain('group_roster')
      expect(filter.authors?.some(author => groupAuthors.has(author)) ?? false).toBe(false)
    }
  }
}
