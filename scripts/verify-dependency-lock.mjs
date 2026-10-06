import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const packages = lockfile.split('\nsnapshots:')[0]
const pubsubRuntime = await readFile(new URL('src/lib/nostrPubsubRuntime.ts', root), 'utf8')
const releases = {
  "nostr-pubsub-reconcile": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-reconcile-ts-v0.1.0/nostr-pubsub-reconcile-0.1.0.tgz",
    "integrity": "sha512-F1UToi75yYrZpt5KFocPUlQH4MeU/J9A/aJBndWUuDvzx1WdQtF99tNxD3KnH2x81R4oaT721hf5OcTdSv8hRg=="
  },
  "@fips/core": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.56/fips-core-0.0.52.tgz",
    "integrity": "sha512-omsxRDNQ0iqEBipCD0sOhodDYm0p8cnjt/6BmcDBvtDgQx9F+wL0LXO8hN7MtqZ7KI40wc/gACAudP2+gscXew=="
  },
  "@fips/tcp": {
    "url": "https://github.com/mmalmi/fips-tcp/releases/download/v0.2.0/fips-tcp-0.2.0.tgz",
    "integrity": "sha512-KCJmltpx4cH76Sp+GOKJvYzQpwUTUtmyBA5bgcfS36ty8AxSgBQZxLdBwM59IER+B/rZpjRYFtqE6MPePL0o+w=="
  },
  "@fips/transport-webrtc": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.56/fips-transport-webrtc-0.0.55.tgz",
    "integrity": "sha512-Vgn4xsjfkhvvqKQVTYdBeAVHPb8SYMHlxYH7vP43FSIurnIW0vhpsgXwznodH5QdAiJG7BOI4PoM85Op9gVFBA=="
  },
  "@fips/transport-websocket": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.56/fips-transport-websocket-0.0.10.tgz",
    "integrity": "sha512-2KIK6BbfN/OY1nwXkdcPsKmlaLSYfhn8V62RY/zQIbgC8j6QVevlfaxRFYfNjraF+Lz1/M/XNav/a62oABCbTg=="
  },
  "@hashtree/core": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.9/hashtree-core-0.3.2.tgz",
    "integrity": "sha512-OLd2ARbYKt9s7wipMX58OhJwZQ6XwIdkuJ+Zfp+NNz3rjXDV8kYl67S9HlrXOj5eSsy5SbN/JuKS8QuwXzEiRQ=="
  },
  "nostr-pubsub": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.14/nostr-pubsub-0.5.14.tgz",
    "integrity": "sha512-+dqXX3k2+pWUz0L2xEQnxYwrbkWaLL1EQPboCAWgbJy0vvuaC5jtEzMUxZddZ52Mtw62N3UzAyEj11k1AUXwDA=="
  },
  "nostr-double-ratchet": {
    "url": "https://github.com/irislib/nostr-double-ratchet/releases/download/nostr-double-ratchet-ts-v0.0.176/nostr-double-ratchet-0.0.176.tgz",
    "integrity": "sha512-tb9RvZpgzdG3TubA0UYijpiNrT0n8IWP1EE3JlxSMOBzIzIKC01S8F5qbZnnlq9H86ohSPnJ4Y5iVqj5271UDA=="
  },
  "nostr-social-graph": {
    "url": "https://github.com/mmalmi/nostr-social-graph/releases/download/v2.0.3/nostr-social-graph-2.0.3.tgz",
    "integrity": "sha512-mdPbzA0PAApbAmwrUFEvTDp/XQ4phzFCpNwwlSSXhqOBRweLRO8m6AtDoURwIEYJN4GJcDuR173ppjxCRrZhnw=="
  },
  "@hashtree/worker": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.19/hashtree-worker-0.4.11.tgz",
    "integrity": "sha512-3lKJ/sic9u0Mc5RhdQNP9aG9SsfvHc7WIjCEBxqNps/JicROjjYKhuPuLKA0oY5LjwA7DhZJfXImcaguyBgM7w=="
  },
  "@hashtree/fips-transport": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.20/hashtree-fips-transport-0.4.21.tgz",
    "integrity": "sha512-VcVFj6GQeousx7w7WH7/sAETlvQSdh8KGBD1CBGGV2XKxvjz4lgtrBlXNdMnjlkd3eRUOxoBOMc+rQvtVYBF8w=="
  },
  "@hashtree/nostr-pubsub": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.11/hashtree-nostr-pubsub-0.1.7.tgz",
    "integrity": "sha512-BmxKhtPatqoBCYojjz6+Z6/ghsfiJPuyy2mM0ePstpm2nJkP34QPYv+WiJStpUT5TUDdfwxeEYqGYJCzLex9Nw=="
  },
  "@hashtree/dexie": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.9/hashtree-dexie-0.1.11.tgz",
    "integrity": "sha512-NGe+rKVuyBrhlWeIemO0Hzd/mAcuN+PqpXYeg508dlvwuRrl+0GNIwRwPVh7e7Zg5VlwiKaN6E5itp9W6EZEGg=="
  },
  "@iris/identity": {
    "url": "https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.6/iris-identity-0.3.1.tgz",
    "integrity": "sha512-HwLi00j/Buf85f//Q4FsKCzvDcidul2U+rNIkfwHZjusNPfJaw6p/Yk4nlKXGkpN4W+TGVj1tZmHGj9Tz8UBAg=="
  }
}

if (manifest.dependencies?.['@iris/nostr-pubsub'] || lockfile.includes('@iris/nostr-pubsub')) {
  throw new Error('The product-local @iris/nostr-pubsub carrier must stay removed')
}
for (const forbidden of ['iris.chat.nostr', 'sendEndpointData', 'endpointData']) {
  if (pubsubRuntime.includes(forbidden)) {
    throw new Error(`Nostr runtime must not restore raw carrier token ${forbidden}`)
  }
}

for (const [name, release] of Object.entries(releases)) {
  if (manifest.dependencies?.[name] !== release.url) {
    throw new Error(`${name} must use immutable release ${release.url}`)
  }
  const quotedKey = `  '${name}@${release.url}':`
  const plainKey = `  ${name}@${release.url}:`
  const start = Math.max(packages.indexOf(quotedKey), packages.indexOf(plainKey))
  const end = packages.indexOf('\n\n', start)
  const entry = start >= 0 ? packages.slice(start, end < 0 ? undefined : end) : ''
  if (!entry.includes(`tarball: ${release.url}`) || !entry.includes(`integrity: ${release.integrity}`)) {
    throw new Error(`${name} lock entry is missing its verified release integrity`)
  }
  const version = new URL(release.url).pathname.match(/-(\d+\.\d+\.\d+(?:-[\w.-]+)?)\.tgz$/)?.[1]
  if (!version || entry.match(/^    version: (.+)$/m)?.[1] !== version) {
    throw new Error(`${name} lock metadata must match release version ${version}`)
  }
}
if ((packages.match(/^  ['"]?@fips\/core@/gm) ?? []).length !== 1) {
  throw new Error('The dependency graph must contain one audited @fips/core release')
}
if (manifest.scripts?.test?.startsWith('pnpm verify:dependency-lock') !== true) {
  throw new Error('The normal test gate must verify GitHub dependency integrity')
}

console.log('Verified immutable shared runtime release integrity')
