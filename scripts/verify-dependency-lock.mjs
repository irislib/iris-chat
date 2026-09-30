import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const workspace = await readFile(new URL('pnpm-workspace.yaml', root), 'utf8')
const pubsubRuntime = await readFile(new URL('src/lib/nostrPubsubRuntime.ts', root), 'utf8')
const releases = {
  '@fips/core': {
    url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.43/fips-core-0.0.43.tgz',
    integrity: 'sha512-6zKvgowk5yBa6SVf5MDgOzn9IKVjJGgoa1oXqfv1uHDt7U98JjbIXdUCbMEUMyHX7qoeutH/2Kw+13E5LTB96A==',
  },
  '@fips/tcp': {
    url: 'https://github.com/mmalmi/fips-tcp/releases/download/v0.2.0/fips-tcp-0.2.0.tgz',
    integrity: 'sha512-KCJmltpx4cH76Sp+GOKJvYzQpwUTUtmyBA5bgcfS36ty8AxSgBQZxLdBwM59IER+B/rZpjRYFtqE6MPePL0o+w==',
  },
  '@fips/transport-webrtc': {
    url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.43/fips-transport-webrtc-0.0.48.tgz',
    integrity: 'sha512-lKCTDAiHT0FNo/SR5ebWysc1mesM+ktNlUtoPIWgRz/rw7IGp3MqN1YUfa3gUmGUb8n6B8utpLn82J3oq1SCRg==',
  },
  '@fips/transport-websocket': {
    url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.31/fips-transport-websocket-0.0.5.tgz',
    integrity: 'sha512-Qj641P/xa7CQpcVQl52u5PgftzGPtGHIva9mpXRcNgdteB5LlTdCA7/GBfRKtuSxGoNaRi1iKHH4fBHitNe30A==',
  },
  '@hashtree/core': {
    url: 'https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.7/hashtree-core-0.3.2.tgz',
    integrity: 'sha512-DAMUpGBcRk6JgecIU5T3AS18gAiXpiwYG2mULq+mec9noWmaVUFBnkMt+ur12IjKik9G146z1cQV5y/oZ7MgFA==',
  },
  'nostr-pubsub': {
    url: 'https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.1/nostr-pubsub-0.5.1.tgz',
    integrity: 'sha512-8Du8STeYMT98zz00lo3uoETYeWpvVGZO3n0Xi9pZycXWPMxCQP1FwRgl0mrxTMT5KK1xOw4pMnpSGmMeVOidag==',
  },
  'nostr-double-ratchet': {
    url: 'https://github.com/irislib/nostr-double-ratchet/releases/download/nostr-double-ratchet-ts-v0.0.173/nostr-double-ratchet-0.0.173.tgz',
    integrity: 'sha512-NlsQ5EhiBl3gJk8ey1YnOsVGQzu4paSPh9Dg1hHxPuw51wKAw9+q+RxtpH9qoVyw5FuTQNLuXas3CBP+WB8I4Q==',
  },
  'nostr-social-graph': {
    url: 'https://github.com/mmalmi/nostr-social-graph/releases/download/v2.0.1/nostr-social-graph-2.0.1.tgz',
    integrity: 'sha512-7bR840Fmz7wYaHi0P9fXxxKlQSphFARmj2VBMIQdFvrNT584bj6ci18GaeJ49OghutUot/FwHmPOTjYqmg6koA==',
  },
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
  const start = Math.max(lockfile.indexOf(quotedKey), lockfile.indexOf(plainKey))
  const end = lockfile.indexOf('\n\n', start)
  const entry = start >= 0 ? lockfile.slice(start, end < 0 ? undefined : end) : ''
  if (!entry.includes(`tarball: ${release.url}`) || !entry.includes(`integrity: ${release.integrity}`)) {
    throw new Error(`${name} lock entry is missing its verified release integrity`)
  }
}
if (!workspace.includes(`'@fips/core': '${releases['@fips/core'].url}'`)) {
  throw new Error('pnpm workspace override must use the audited @fips/core release')
}
if (manifest.scripts?.test?.startsWith('pnpm verify:dependency-lock') !== true) {
  throw new Error('The normal test gate must verify GitHub dependency integrity')
}

console.log('Verified immutable shared runtime release integrity')
