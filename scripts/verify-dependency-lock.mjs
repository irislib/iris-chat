import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const packages = lockfile.split('\nsnapshots:')[0]
const pubsubRuntime = await readFile(new URL('src/lib/nostrPubsubRuntime.ts', root), 'utf8')
const releases = {
  "@iris/profile-events": {
    "url": "https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.13/iris-profile-events-0.1.0.tgz",
    "integrity": "sha512-f61CH/ygvxssR12uvIgWJGcFkYCr4gXoxR/FR2nglqDmHCLtvuR4RPsM47d5ppL8eP64iUK06RjO055ZhwN3Rw=="
  },
  "nostr-pubsub-reconcile": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-reconcile-ts-v0.1.2/nostr-pubsub-reconcile-0.1.2.tgz",
    "integrity": "sha512-w2N8AE2bL5h7H0tOuTONOTprHS4/SVCP93lyipA/mekk+RogF3fZFh+s2lxLEDvW5tSjIJcBdX1lguX7wD5+2g=="
  },
  "@fips/core": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.63/fips-core-0.0.58.tgz",
    "integrity": "sha512-UW0PHboZgifo806XxYYjNGgPsKYDMA59YQSvFD0j1k5lhAofX1Yfx+kH38mTYWeTNJQKSr7cMaWqM1Ue2pSV8g=="
  },
  "@fips/tcp": {
    "url": "https://github.com/mmalmi/fips-tcp/releases/download/fips-tcp-ts-v0.2.6/fips-tcp-0.2.6.tgz",
    "integrity": "sha512-lXQHNwTZEyXGYWqzRlNyKpb2UgNWJOon6HljbY1F1Ey49Q9IoE/kdF84gaTkrCpMPS8M/A6y5FTaFPOLl60+bw=="
  },
  "@fips/transport-webrtc": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.63/fips-transport-webrtc-0.0.62.tgz",
    "integrity": "sha512-X4fGxJvosbK62DqW9Zp8mkzMmmH8grVMxKSbtsqgWRCHNIP1nBKQdvmjeYjVG3/KTTVTZXETRQFLSM9ZS2WW7A=="
  },
  "@fips/transport-websocket": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.63/fips-transport-websocket-0.0.16.tgz",
    "integrity": "sha512-2KUDBS9/UQ+g+vguCf5hSZBShFGZW9ffXCYXx8jQI9yL9Q8rj8mxd+bnOrv5qAVG8ymbqErI2oVCkyLkpT9cvw=="
  },
  "@hashtree/core": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.42/hashtree-core-0.4.2.tgz",
    "integrity": "sha512-9gPIe39QJoCUtVo8VhbDOX5bHAtGlJ2EZlQJqKh3l9++2CY1Njg2LINXQWBgKRqB0P2LBKoDpyYz1XIBoJ/SMw=="
  },
  "nostr-pubsub": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.42/nostr-pubsub-0.5.42.tgz",
    "integrity": "sha512-kuEV8FVRU3zPtwTgG95JhztEkPBPV4wQ8Jv+pD6EHF/UfKS/3RpsB/q/+yd6ms9CM/obdbh6xNItOUrSvvBusw=="
  },
  "nostr-double-ratchet": {
    "url": "https://registry.npmjs.org/nostr-double-ratchet/-/nostr-double-ratchet-0.0.187.tgz",
    "integrity": "sha512-4/PMo+4ppVe1Qc67iMazqnsEQNq2n35mxb+iTSkxcwHJgkX3Fv2v7vI3aa6Xc5MVh+E49ISFukj6PTvekBuFfg=="
  },
  "nostr-social-graph": {
    "url": "https://github.com/mmalmi/nostr-social-graph/releases/download/v4.2.5/nostr-social-graph-4.2.5.tgz",
    "integrity": "sha512-SbIf1758zSgdkOWWuxNrHmphzfEn5Y4kbD2LPkBI/sl4CrEifpzfXjNt621YD9FRElk+HTt7+HBk7Ht2HU1iyA=="
  },
  "@hashtree/worker": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.48/hashtree-worker-0.4.30.tgz",
    "integrity": "sha512-eGw1RZxP1lsMQxo8irD4Xkfw16jx7INnTOx4GKBXWmrzO5AqKJ0asB+pOLJZhXxp6eukObTwSe8qqm2Wkcjh6g=="
  },
  "@hashtree/fips-transport": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.52/hashtree-fips-transport-0.5.3.tgz",
    "integrity": "sha512-aCyAsJwA6uIePNYa7JJtkv/75xcFG/M11LB2llNAiS1qLOz1v3c681XkfHBRmeUqGWoBwyJMBHXmjvQB+vq/Mw=="
  },
  "@hashtree/nostr-pubsub": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-nostr-pubsub-0.1.9.tgz",
    "integrity": "sha512-7QfJ1LwAYb8ThdA/ECXJQYxh7BjQk/gTQS+XAfnZvzjxx5YSDRjGj+7bqLtbDdIAPDuIA9dUNYCfH8oj9RLdPQ=="
  },
  "@hashtree/dexie": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.46/hashtree-dexie-0.1.15.tgz",
    "integrity": "sha512-YPn2gh0QQQRMcZY3zYmkycLqBjKJhA8GEmWq2/LPSbD0441YEQPCkWvTfAgRUsXA+gvjxB51tvqev1caXylp8A=="
  },
  "@iris/identity": {
    "url": "https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.9/iris-identity-0.4.0.tgz",
    "integrity": "sha512-ZZ7qRjOXl+7fLqsSrWEn9eOysrsbXDsHQz6uxZZw+4wnw3qZXi3xHVdWAia7ykTmFm3euDjNHA+raG33xjacWg=="
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
// Older transitive pins must not create a second runtime in the worker or a peer source.
const singletons = ['@fips/core', '@fips/tcp', 'nostr-pubsub', 'nostr-pubsub-reconcile', 'nostr-social-graph']
for (const name of singletons) {
  const entries = packages.match(new RegExp(`^  ['"]?${name}@`, 'gm')) ?? []
  if (entries.length !== 1) {
    throw new Error(`The dependency graph must contain one audited ${name} release`)
  }
}
if (manifest.scripts?.test?.startsWith('pnpm verify:dependency-lock') !== true) {
  throw new Error('The normal test gate must verify GitHub dependency integrity')
}


// The vendor path is stable; its contents are the qualified shared SDK release.
const fileTransfer = {
  specifier: 'file:vendor/fips-file-transfer-0.1.0.tgz',
  version: '0.1.1',
  sha256: 'fd40ec68ea586d2adf460859ce86794c33b39af5b8f44cfec7d03d851bafc9ef',
  integrity: 'sha512-M4+KerF8mCx8MjAjnCyJKt1kq0d5Dvq/Ac20TJd0uRgyc3mxriBMYH37HOqnBQ5ehGqiGd9bY7wzrCdqOq8LTw==',
}
if (manifest.dependencies?.['@fips/file-transfer'] !== fileTransfer.specifier) {
  throw new Error('File transfers must use the verified shared SDK vendor archive')
}
const fileTransferBytes = await readFile(new URL(fileTransfer.specifier.slice(5), root))
if (createHash('sha256').update(fileTransferBytes).digest('hex') !== fileTransfer.sha256 ||
    `sha512-${createHash('sha512').update(fileTransferBytes).digest('base64')}` !== fileTransfer.integrity) {
  throw new Error('File-transfer vendor bytes differ from the verified SDK release')
}
const fileTransferKey = `  '@fips/file-transfer@${fileTransfer.specifier}':`
const fileTransferStart = packages.indexOf(fileTransferKey)
const fileTransferEnd = packages.indexOf('\n\n', fileTransferStart)
const fileTransferEntry = fileTransferStart < 0 ? '' : packages.slice(fileTransferStart, fileTransferEnd < 0 ? undefined : fileTransferEnd)
if ((packages.match(/^  ['"]?@fips\/file-transfer@/gm) ?? []).length !== 1 ||
    !fileTransferEntry.includes(`tarball: ${fileTransfer.specifier}`) ||
    !fileTransferEntry.includes(`integrity: ${fileTransfer.integrity}`) ||
    fileTransferEntry.match(/^    version: (.+)$/m)?.[1] !== fileTransfer.version) {
  throw new Error('File-transfer lock metadata must match the verified vendor release')
}

console.log('Verified immutable shared runtime release integrity')
