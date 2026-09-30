import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const packages = lockfile.split('\nsnapshots:')[0]
const workspace = await readFile(new URL('pnpm-workspace.yaml', root), 'utf8')
const pubsubRuntime = await readFile(new URL('src/lib/nostrPubsubRuntime.ts', root), 'utf8')
const releases = {
  "@fips/core": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.44/fips-core-0.0.44.tgz",
    "integrity": "sha512-64RklKjkFFppkxxhLgCYjXNwuPhTPGV9WVg1nHPH1NljEkS1Bt3aZEhxIk20nE/dZDaWmbD47FGiofMSMWedxw=="
  },
  "@fips/tcp": {
    "url": "https://github.com/mmalmi/fips-tcp/releases/download/v0.2.0/fips-tcp-0.2.0.tgz",
    "integrity": "sha512-KCJmltpx4cH76Sp+GOKJvYzQpwUTUtmyBA5bgcfS36ty8AxSgBQZxLdBwM59IER+B/rZpjRYFtqE6MPePL0o+w=="
  },
  "@fips/transport-webrtc": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.44/fips-transport-webrtc-0.0.49.tgz",
    "integrity": "sha512-iidNN5W89AQXzbssNuuae84gq7gJV09k6ZI6SbqqImuN5/6D3hi15/UVx2p3OLV5y+znpE0cIjB4Bew7oaFfzg=="
  },
  "@fips/transport-websocket": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.44/fips-transport-websocket-0.0.6.tgz",
    "integrity": "sha512-dzquYryja3/1rYdyIV2ohxrA6m/5U3bCDrJoEPg9tN9xIWzckntsHxSiqvFw221wYO4bUrRk1lIoVjDnheQ/1g=="
  },
  "@hashtree/core": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.9/hashtree-core-0.3.2.tgz",
    "integrity": "sha512-OLd2ARbYKt9s7wipMX58OhJwZQ6XwIdkuJ+Zfp+NNz3rjXDV8kYl67S9HlrXOj5eSsy5SbN/JuKS8QuwXzEiRQ=="
  },
  "nostr-pubsub": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.13/nostr-pubsub-0.5.13.tgz",
    "integrity": "sha512-iL94fAtLDh5agPo/4qOgfy5QUmQL2GY/LFL4zp/H9U6St1+hJpLAcrA4eQLZlwyvtIXQu1tOtpdHkuhu4wEZ9A=="
  },
  "nostr-double-ratchet": {
    "url": "https://github.com/irislib/nostr-double-ratchet/releases/download/nostr-double-ratchet-ts-v0.0.174/nostr-double-ratchet-0.0.174.tgz",
    "integrity": "sha512-tSWSNsfqbjM9sq7N1A/Sltt9nTO4EYCHUAr7D+k9hWU3s5vNUCtvdcTCXNqzudPddtHwhby57pK9+gvwHKCPRA=="
  },
  "nostr-social-graph": {
    "url": "https://github.com/mmalmi/nostr-social-graph/releases/download/v2.0.1/nostr-social-graph-2.0.1.tgz",
    "integrity": "sha512-7bR840Fmz7wYaHi0P9fXxxKlQSphFARmj2VBMIQdFvrNT584bj6ci18GaeJ49OghutUot/FwHmPOTjYqmg6koA=="
  },
  "@hashtree/worker": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.11/hashtree-worker-0.4.7.tgz",
    "integrity": "sha512-ZIkcdIYY9XXKhi2w9HfsdrEFPSe0Qlm9+OSxVGGjBH/+YJf6lwQkrGR/00KqX4GAJVjI59B3rPwcqBAH6Mlo1Q=="
  },
  "@hashtree/fips-transport": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.12/hashtree-fips-transport-0.4.15.tgz",
    "integrity": "sha512-TG9WuaN8haDCmP9L5+TJLYrYXxXrZjWoaSqAEd5GiME7Dpc93ZfbaGb/jktiLKx3Aqrf+zuUsr6cTPuHVDjkZw=="
  },
  "@hashtree/nostr-pubsub": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.11/hashtree-nostr-pubsub-0.1.7.tgz",
    "integrity": "sha512-BmxKhtPatqoBCYojjz6+Z6/ghsfiJPuyy2mM0ePstpm2nJkP34QPYv+WiJStpUT5TUDdfwxeEYqGYJCzLex9Nw=="
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
}
if (!workspace.includes(`'@fips/core': '${releases['@fips/core'].url}'`)) {
  throw new Error('pnpm workspace override must use the audited @fips/core release')
}
if (manifest.scripts?.test?.startsWith('pnpm verify:dependency-lock') !== true) {
  throw new Error('The normal test gate must verify GitHub dependency integrity')
}

console.log('Verified immutable shared runtime release integrity')
