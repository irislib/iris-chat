import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const packages = lockfile.split('\nsnapshots:')[0]
const pubsubRuntime = await readFile(new URL('src/lib/nostrPubsubRuntime.ts', root), 'utf8')
const releases = {
  "nostr-pubsub-reconcile": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-reconcile-ts-v0.1.1/nostr-pubsub-reconcile-0.1.1.tgz",
    "integrity": "sha512-hrwY11Np7ufQaqMBQyHJvOjN+fjCfFQ0kTQDzVgALay0ogmP7RLAvDtQmx7U3KOGrGKGoZKLnbeKfsNLCykB+Q=="
  },
  "@fips/core": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.58/fips-core-0.0.53.tgz",
    "integrity": "sha512-jcqmCKN11BkNeGF3sO74zAB/XF0iezoM+A72/5hl6rBa6HSF/A2ojzqo7/sLs6WoeZDVZxwrwwRYUxYFeYliIQ=="
  },
  "@fips/tcp": {
    "url": "https://github.com/mmalmi/fips-tcp/releases/download/fips-tcp-v0.2.5/fips-tcp-0.2.4.tgz",
    "integrity": "sha512-iBPJLtnunUn+Y2vjZ5D8eTKJHjznDX3DZs7x5oXzx9kc5u9W71l6mHg/cQiQr5LKKU+FtjiPLGAPLW9iz1S41w=="
  },
  "@fips/transport-webrtc": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.58/fips-transport-webrtc-0.0.57.tgz",
    "integrity": "sha512-7acqPWb5SOBJcrxwilUGw0+zgaDrYWEOOrxxKQnvhhHMrwjSGOVmHBNG7nddvWsTT315wiLXZfYmfJ6yNgLDKw=="
  },
  "@fips/transport-websocket": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.58/fips-transport-websocket-0.0.11.tgz",
    "integrity": "sha512-oadcKDkA8Zma8ssxY3M60+EjeCXPO1jVx6/hDqer37r2Kk3FeAIuR3t3ONYjgT5vDY7ySzmRp+yE2S+i8qgEbg=="
  },
  "@hashtree/core": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-core-0.4.0.tgz",
    "integrity": "sha512-hdqjU1MoGjc55BL5WM93jgVxW7cYOWCWHcYUl5glUT8boEinFfmlmnhyjGp7TNwWgxZKQ7Rgag9XiyDnRUGBUA=="
  },
  "nostr-pubsub": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.24/nostr-pubsub-0.5.24.tgz",
    "integrity": "sha512-IYAPHnhLlYpIkUbG0jPCJC3lxXz3In72kqDdmBSpFN0RvP74HpyLhEWBzSP/YA5XRt/1TnqoxeQ2JXL2Q5SYhQ=="
  },
  "nostr-double-ratchet": {
    "url": "https://registry.npmjs.org/nostr-double-ratchet/-/nostr-double-ratchet-0.0.183.tgz",
    "integrity": "sha512-CPvJzniY+nItLVEQpH4jaRnmU7AMkD3kAN5yByXMgmm4MNChAk8X8HY8oJIw1riX/gW3/WKD8c+eUtSgu98DDA=="
  },
  "nostr-social-graph": {
    "url": "https://github.com/mmalmi/nostr-social-graph/releases/download/v4.1.0/nostr-social-graph-4.1.0.tgz",
    "integrity": "sha512-9jHMueBoZOsgsI80XWh4oirJTxoOsvTEs1JvlyIQkrw78ykOi3725fXOmSCKmULyS5vHioitAToOkBru5u1Jcw=="
  },
  "@hashtree/worker": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.38/hashtree-worker-0.4.23.tgz",
    "integrity": "sha512-VoCicyPS1ksStzr1swScV1UZ8MwnwaiI02HKq4xRV6ZVee8ukWv8JkhKaj2e4RSOZ32cnoHC+KheowGrKrdeBA=="
  },
  "@hashtree/fips-transport": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.38/hashtree-fips-transport-0.5.0.tgz",
    "integrity": "sha512-1hUDOllGMrhtcfs9YosXqdNE7VVqEhe45uHB92AK4UTrlTFitin6NVWTdGnDVNBImPA2doPkJSmBdlBMF4N17A=="
  },
  "@hashtree/nostr-pubsub": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-nostr-pubsub-0.1.9.tgz",
    "integrity": "sha512-7QfJ1LwAYb8ThdA/ECXJQYxh7BjQk/gTQS+XAfnZvzjxx5YSDRjGj+7bqLtbDdIAPDuIA9dUNYCfH8oj9RLdPQ=="
  },
  "@hashtree/dexie": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-dexie-0.1.13.tgz",
    "integrity": "sha512-i34YCDwA+d4puwtC2f+4NreOLRC/RRTOe3PDHXctJvaqg2Ig+xpGcb2I1cbjjCY0cVJ8/BTemNYrH0LfXckPwQ=="
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
  const version = new URL(release.url).pathname.match(/-(\d+\.\d+\.\d+(?:-[\w.-]+)?)\.tgz$/)?.[1]
  // pnpm canonicalizes npm registry tarballs to a version key while retaining
  // the exact tarball digest and the original URL in the importer.
  const registryRelease = new URL(release.url).hostname === 'registry.npmjs.org'
  const packageRef = registryRelease ? version : release.url
  const quotedKey = `  '${name}@${packageRef}':`
  const plainKey = `  ${name}@${packageRef}:`
  const start = Math.max(packages.indexOf(quotedKey), packages.indexOf(plainKey))
  const end = packages.indexOf('\n\n', start)
  const entry = start >= 0 ? packages.slice(start, end < 0 ? undefined : end) : ''
  if ((!registryRelease && !entry.includes(`tarball: ${release.url}`)) || !entry.includes(`integrity: ${release.integrity}`)) {
    throw new Error(`${name} lock entry is missing its verified release integrity`)
  }
  if (!version || (!registryRelease && entry.match(/^    version: (.+)$/m)?.[1] !== version)) {
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
