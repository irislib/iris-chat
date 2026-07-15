import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const irisPubsubCommit = '3c78a5adef9af1053f6563a1b25bee4510dccc53'
const irisPubsub = `github:mmalmi/iris-kit#${irisPubsubCommit}&path:/packages/nostr-pubsub`
const releases = {
  '@fips/core': {
    url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.24/fips-core-0.0.24.tgz',
    integrity: 'sha512-oncWv7eAjKDjMVpxqFELcidOPHQc7S3ocD9K/d++8vdbQKuJEm+gnQTWfyOi1gKeu/U9NoR5UBJ9SCMIhjU2Sg==',
  },
  '@fips/tcp': {
    url: 'https://github.com/mmalmi/fips-tcp/releases/download/v0.2.0/fips-tcp-0.2.0.tgz',
    integrity: 'sha512-KCJmltpx4cH76Sp+GOKJvYzQpwUTUtmyBA5bgcfS36ty8AxSgBQZxLdBwM59IER+B/rZpjRYFtqE6MPePL0o+w==',
  },
  '@fips/transport-webrtc': {
    url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.24/fips-transport-webrtc-0.0.40.tgz',
    integrity: 'sha512-9XxawnsV0NfsnBxrjvHDm+b7ceiJ7NoleBbREo0vS4uqASFDr0I6xacG+XOBUEmcnWvKK5Vm1w3NNoL6hFJyNQ==',
  },
  'nostr-pubsub': {
    url: 'https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.2.0/nostr-pubsub-0.2.0.tgz',
    integrity: 'sha512-6lMNGBDy9git6nDUydr3B77ZAux6wWfeZgEpF7hJ3ckZ1162soR57jguX3N1hToMkPWvYUwFK+cbTfPvGxbTqw==',
  },
}

if (manifest.dependencies?.['@iris/nostr-pubsub'] !== irisPubsub) {
  throw new Error(`@iris/nostr-pubsub must use audited revision ${irisPubsub}`)
}
if (!lockfile.includes(`mmalmi/iris-kit/tar.gz/${irisPubsubCommit}#path:/packages/nostr-pubsub`)) {
  throw new Error('@iris/nostr-pubsub lock entry is not pinned to the audited revision')
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
if (manifest.scripts?.test?.startsWith('pnpm verify:dependency-lock') !== true) {
  throw new Error('The normal test gate must verify GitHub dependency integrity')
}

console.log('Verified immutable FIPS and nostr-pubsub release integrity')
