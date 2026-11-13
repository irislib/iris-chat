import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

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
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.61/fips-core-0.0.56.tgz",
    "integrity": "sha512-vXfPsXWlXIEZFFl6K+x9YCwOhRPQr4gjw+GfWOfuyI1RW1O1tcdKQBcDbIszByNWVCt/Rs8UOAzv+k+iXNlIOQ=="
  },
  "@fips/tcp": {
    "url": "https://github.com/mmalmi/fips-tcp/releases/download/fips-tcp-v0.2.5/fips-tcp-0.2.4.tgz",
    "integrity": "sha512-iBPJLtnunUn+Y2vjZ5D8eTKJHjznDX3DZs7x5oXzx9kc5u9W71l6mHg/cQiQr5LKKU+FtjiPLGAPLW9iz1S41w=="
  },
  "@fips/transport-webrtc": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.61/fips-transport-webrtc-0.0.60.tgz",
    "integrity": "sha512-te9hazkbDXnV4hBYX4pIX594WDY5XVClh9tZCVAm5GzE8bHyoFEAhIpyWiUpbciawaYdRLubkcar3D8A7bViYA=="
  },
  "@fips/transport-websocket": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.61/fips-transport-websocket-0.0.14.tgz",
    "integrity": "sha512-B+CUOBXuMwfDzLCnr+QfLf/MuA4wcV+36mqwH+RS0DNRYFcoGgM60MZiwcjFVCb6xzl0ZTUYe9Sla+VJ2MJBnQ=="
  },
  "@hashtree/core": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-core-0.4.0.tgz",
    "integrity": "sha512-hdqjU1MoGjc55BL5WM93jgVxW7cYOWCWHcYUl5glUT8boEinFfmlmnhyjGp7TNwWgxZKQ7Rgag9XiyDnRUGBUA=="
  },
  "nostr-pubsub": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.29/nostr-pubsub-0.5.29.tgz",
    "integrity": "sha512-ENSpu5VHgKmf14Gg239I/h7k0taZ2BcQ1EumMbE4NEnIbUUX7auCVCmQDlOJfwArSIpTgUEDkKyI10NSYS6A/A=="
  },
  "nostr-double-ratchet": {
    "url": "https://registry.npmjs.org/nostr-double-ratchet/-/nostr-double-ratchet-0.0.187.tgz",
    "integrity": "sha512-4/PMo+4ppVe1Qc67iMazqnsEQNq2n35mxb+iTSkxcwHJgkX3Fv2v7vI3aa6Xc5MVh+E49ISFukj6PTvekBuFfg=="
  },
  "nostr-social-graph": {
    "url": "https://github.com/mmalmi/nostr-social-graph/releases/download/v4.0.4/nostr-social-graph-4.0.4.tgz",
    "integrity": "sha512-7lMB0fYsjIBQwn/03lY8+0gq41rzifG4hmp5iczjrdBZ/FWQQvkkrH2HGtL80lMhkYr5+UqV63DaBdtoaReDtA=="
  },
  "@hashtree/worker": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.41/hashtree-worker-0.4.25.tgz",
    "integrity": "sha512-viUPl2JUtrfJENEWZPvaTtT5x73Pvj5EmHn7qjsTP5T01uOg0tDm7xJww3cf6x23LILi6drOh97ss0WWYq/KVA=="
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
