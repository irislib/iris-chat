import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const packageName = 'nostr-pubsub'
const url = 'https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.1.5/nostr-pubsub-0.1.5.tgz'
const integrity = 'sha512-zza+r1FWKMopO4XUxLD0GfnBvUOpNju9Pr4nKCZ8np8xqo0sKDaCcbM/VvZmjNd2/iHdtyducpkrmAXnqUt+9w=='
const fipsTcp = 'github:mmalmi/fips-tcp#353cd0b9b723edd07b6cdc82c7e826d43b9a0d6e&path:/ts'
const irisPubsubCommit = '3c78a5adef9af1053f6563a1b25bee4510dccc53'
const irisPubsub = `github:mmalmi/iris-kit#${irisPubsubCommit}&path:/packages/nostr-pubsub`

if (manifest.dependencies?.['@iris/nostr-pubsub'] !== irisPubsub) {
  throw new Error(`@iris/nostr-pubsub must use the audited immutable revision ${irisPubsub}`)
}
if (manifest.dependencies?.['@fips/tcp'] !== fipsTcp) {
  throw new Error(`@fips/tcp must use the audited immutable revision ${fipsTcp}`)
}
if (!lockfile.includes(`mmalmi/iris-kit/tar.gz/${irisPubsubCommit}#path:/packages/nostr-pubsub`)) {
  throw new Error('@iris/nostr-pubsub lock entry is not pinned to the audited revision')
}
if (!lockfile.includes('mmalmi/fips-tcp/tar.gz/353cd0b9b723edd07b6cdc82c7e826d43b9a0d6e#path:/ts')) {
  throw new Error('@fips/tcp lock entry is not pinned to the audited revision')
}
const pubsubEntryStart = lockfile.indexOf(`nostr-pubsub@${url}:`)
const pubsubEntry = lockfile.slice(pubsubEntryStart, lockfile.indexOf('\n\n', pubsubEntryStart))
if (pubsubEntryStart < 0 || !pubsubEntry.includes(url) || !pubsubEntry.includes(integrity)) {
  throw new Error(`${packageName} wrapped by @iris/nostr-pubsub is missing its pinned SHA-512 integrity`)
}
if (manifest.scripts?.test?.startsWith('pnpm verify:dependency-lock') !== true) {
  throw new Error('The normal test gate must verify GitHub dependency integrity')
}

console.log(`Verified ${packageName} GitHub release integrity`)
