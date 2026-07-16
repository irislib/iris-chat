import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const workspace = await readFile(new URL('pnpm-workspace.yaml', root), 'utf8')
const pubsubRuntime = await readFile(new URL('src/lib/nostrPubsubRuntime.ts', root), 'utf8')
const releases = {
  '@fips/core': {
    url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.26/fips-core-0.0.26.tgz',
    integrity: 'sha512-plDWMSHjjVyH4BnkO4GgZcvpgIV6LTFspcWF1Gg0LE7sI+dAsqHP+OfAP6VKBh91QX6SSvJ2G4TJI28nfbNsLA==',
  },
  '@fips/tcp': {
    url: 'https://github.com/mmalmi/fips-tcp/releases/download/v0.2.0/fips-tcp-0.2.0.tgz',
    integrity: 'sha512-KCJmltpx4cH76Sp+GOKJvYzQpwUTUtmyBA5bgcfS36ty8AxSgBQZxLdBwM59IER+B/rZpjRYFtqE6MPePL0o+w==',
  },
  '@fips/transport-webrtc': {
    url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.26/fips-transport-webrtc-0.0.42.tgz',
    integrity: 'sha512-vqbMj4mgJdS5sAXYLe4kb9B3ZtdnNFsQof3y0W2vF4TruccMH48AmxY+J6gOKCwhOHkFFgJ9V/4m1MVKzLsIiw==',
  },
  '@hashtree/core': {
    url: 'https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.4.2/hashtree-core-0.2.1.tgz',
    integrity: 'sha512-kkZKx/mNqImMy1DnWXRgv2LHaf5HbZg8sIpHV6/wLZKl3cQkmSY9xtjCZSTlUXeXIgOmxDzqDGa2GNf5Rg7b/A==',
  },
  'nostr-pubsub': {
    url: 'https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.3.0/nostr-pubsub-0.3.0.tgz',
    integrity: 'sha512-ApsAMv4jaHtff8cIcDoRjPF+RpZ6cn2IFPl0iMYvliXJd/5Dtz9umh6uRHSjFvkVlCNUCyEgQ2p5IEOKRd+Mpw==',
  },
  'nostr-double-ratchet': {
    url: 'https://github.com/irislib/nostr-double-ratchet/releases/download/nostr-double-ratchet-ts-v0.0.165/nostr-double-ratchet-0.0.165.tgz',
    integrity: 'sha256-5vwY+wdlWoPfnyViBgHEoc4UFUechvthHuJ6MoYRBXU=',
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
