import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const packages = lockfile.split('\nsnapshots:')[0]
const pubsubRuntime = await readFile(new URL('src/lib/nostrPubsubRuntime.ts', root), 'utf8')
const cohort = JSON.parse(await readFile(new URL('scripts/runtime-cohort.json', root), 'utf8'))
const releases = {
  ...cohort.packages,
  "@iris/profile-events": {
    "url": "https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.13/iris-profile-events-0.1.0.tgz",
    "integrity": "sha512-f61CH/ygvxssR12uvIgWJGcFkYCr4gXoxR/FR2nglqDmHCLtvuR4RPsM47d5ppL8eP64iUK06RjO055ZhwN3Rw=="
  },
  "nostr-pubsub-reconcile": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-reconcile-ts-v0.1.2/nostr-pubsub-reconcile-0.1.2.tgz",
    "integrity": "sha512-w2N8AE2bL5h7H0tOuTONOTprHS4/SVCP93lyipA/mekk+RogF3fZFh+s2lxLEDvW5tSjIJcBdX1lguX7wD5+2g=="
  },
  "nostr-double-ratchet": {
    "url": "https://registry.npmjs.org/nostr-double-ratchet/-/nostr-double-ratchet-0.0.189.tgz",
    "integrity": "sha512-FNDz6KvHBYIQQrMW02Pyw/1gYFrijX8lnpITCdA+X+A/nRMjUUilzWTAsD1IeRTDbeBEJ4rxQ284bIpPXzR9kw=="
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
  const entries = packages.match(new RegExp(`^  ['\"]?${name}@`, 'gm')) ?? []
  if (!entries.length && !manifest.dependencies?.[name]) continue
  if (entries.length !== 1) throw new Error(`The graph must contain one audited ${name} release`)
  if (manifest.dependencies?.[name] && manifest.dependencies[name] !== release.url) {
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
const fileTransfer = JSON.parse(await readFile(new URL('scripts/file-transfer-release.json', root), 'utf8'))

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
