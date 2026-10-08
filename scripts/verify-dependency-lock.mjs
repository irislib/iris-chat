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
    "url": "https://github.com/mmalmi/fips-tcp/releases/download/fips-tcp-v0.2.5/fips-tcp-0.2.4.tgz",
    "integrity": "sha512-iBPJLtnunUn+Y2vjZ5D8eTKJHjznDX3DZs7x5oXzx9kc5u9W71l6mHg/cQiQr5LKKU+FtjiPLGAPLW9iz1S41w=="
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
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.15/nostr-pubsub-0.5.15.tgz",
    "integrity": "sha512-59CecbZTYxPjY0zBBvZwhbQsC9bwTkTYBKUG2v+tePw90KfUmzEolQus/CzwYns4MJNeQHq4oVYXfw7cVvDMbA=="
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
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.21/hashtree-worker-0.4.12.tgz",
    "integrity": "sha512-U9Og1k/Nf2z13mqi87SYLziBHLb+xMLSyGIAkoe80SOYmfwPue+DKURs2AjAXb9t15vSVnZ9BlBZwR2b+vfiEQ=="
  },
  "@hashtree/fips-transport": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.21/hashtree-fips-transport-0.4.22.tgz",
    "integrity": "sha512-tSqjcaxdpz8gBuay+JWpo4WvprnV7qlaGgKr0igwalarHVT9tDDF9kpHOgDiHFq0cqiFVwCZ+bDtQt7U8rfvnw=="
  },
  "@hashtree/nostr-pubsub": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.21/hashtree-nostr-pubsub-0.1.8.tgz",
    "integrity": "sha512-hyqGgHna8Hr+vDyI8bD9Got4XxNkciMPwkC6d5inCpWTEhZSkNopvcpgM54og2FSgW2d6UhV2E2V4r4vKx+/tw=="
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
if ((packages.match(/^  ['"]?@fips\/tcp@/gm) ?? []).length !== 1) {
  throw new Error('The dependency graph must contain one audited @fips/tcp release')
}
if (manifest.scripts?.test?.startsWith('pnpm verify:dependency-lock') !== true) {
  throw new Error('The normal test gate must verify GitHub dependency integrity')
}

console.log('Verified immutable shared runtime release integrity')
