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
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.57/fips-transport-webrtc-0.0.56.tgz",
    "integrity": "sha512-rxRtF4TLPuRicue+GeuG/jsIJXFUmOYRLQDlgULJYMPFcf1JO1dD1B7RgrjT+bF6ssGrNoNP+NUd77lKnTli2Q=="
  },
  "@fips/transport-websocket": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.56/fips-transport-websocket-0.0.10.tgz",
    "integrity": "sha512-2KIK6BbfN/OY1nwXkdcPsKmlaLSYfhn8V62RY/zQIbgC8j6QVevlfaxRFYfNjraF+Lz1/M/XNav/a62oABCbTg=="
  },
  "@hashtree/core": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-core-0.4.0.tgz",
    "integrity": "sha512-hdqjU1MoGjc55BL5WM93jgVxW7cYOWCWHcYUl5glUT8boEinFfmlmnhyjGp7TNwWgxZKQ7Rgag9XiyDnRUGBUA=="
  },
  "nostr-pubsub": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.20/nostr-pubsub-0.5.20.tgz",
    "integrity": "sha512-1Cwdk2LR4oCtxiOR1t5+KmdrzDUKrqZfbIZzpXrOR0g+Ex3DCZ33him/qPWU/iYTChPl9eUgi1ZdhL0KdQWZWQ=="
  },
  "nostr-double-ratchet": {
    "url": "https://registry.npmjs.org/nostr-double-ratchet/-/nostr-double-ratchet-0.0.183.tgz",
    "integrity": "sha512-CPvJzniY+nItLVEQpH4jaRnmU7AMkD3kAN5yByXMgmm4MNChAk8X8HY8oJIw1riX/gW3/WKD8c+eUtSgu98DDA=="
  },
  "nostr-social-graph": {
    "url": "https://github.com/mmalmi/nostr-social-graph/releases/download/v3.0.0/nostr-social-graph-3.0.0.tgz",
    "integrity": "sha512-WYipehbl5EGdnBiusXpTQ0rOu7eeHK708hNd/8Jd9NdpQqfNe+gy1LxiFBhdR9y+3OPuqqfqmQ/pyCTeIzK0LA=="
  },
  "@hashtree/worker": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-worker-0.4.17.tgz",
    "integrity": "sha512-S6+zasXf03S9BOUDirK0Py+2hGPIsk0VuWreRkFecsUDF91iznS3k0lX037tFOqLgjAUCvilzesd8VlEjO/0bA=="
  },
  "@hashtree/fips-transport": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-fips-transport-0.4.24.tgz",
    "integrity": "sha512-86f/HNa0R/0yLPXUKynlmAZqdAk9bxrgLVnAygNDOAQflsraWjYjltbmAXpQF2f6RMRvp4pKqVFyhjmle50Gbg=="
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
