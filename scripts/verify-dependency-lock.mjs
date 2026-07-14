import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const packageName = 'nostr-pubsub'
const url = 'https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.1.4/nostr-pubsub-0.1.4.tgz'
const integrity = 'sha512-Rm0e+UC1YBnjPjgHED0t+S6+ytUjz9l1ld1AiFiilpC2OU1HDZxtUUrJTjupoe97v6NUUhywkoNNLrZ9LHB9HA=='

if (manifest.dependencies?.[packageName] !== url) {
  throw new Error(`${packageName} must load from the pinned GitHub release ${url}`)
}
if (!lockfile.includes(`tarball: ${url}, integrity: ${integrity}`)) {
  throw new Error(`${packageName} is missing its pinned SHA-512 integrity in pnpm-lock.yaml`)
}
if (manifest.scripts?.test?.startsWith('pnpm verify:dependency-lock') !== true) {
  throw new Error('The normal test gate must verify GitHub dependency integrity')
}

console.log(`Verified ${packageName} GitHub release integrity`)
