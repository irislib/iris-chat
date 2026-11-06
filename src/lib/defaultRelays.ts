export const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://temp.iris.to',
  'wss://offchain.pub',
]

// Message delivery retains its established destinations. Fresh public browsing
// and publication may also use Ditto; a saved selection never gains a relay.
export const DEFAULT_PUBLIC_RELAYS = ['wss://relay.ditto.pub', ...DEFAULT_RELAYS]
