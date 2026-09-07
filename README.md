# iris chat

> Main development is on [decentralized git](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat): `htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat`

Decentralized encrypted messaging over Nostr using the double-ratchet protocol.

## Features

- **End-to-end encryption** via [nostr-double-ratchet](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/nostr-double-ratchet)
- **QR code invites** for easy contact sharing
- **Push notifications** with service worker integration
- **PWA** installable on mobile and desktop
- **Local-first** with IndexedDB persistence (Dexie)
- **NIP-07** browser extension support for key management
- **Bounded live pubsub** over authenticated FIPS links between machine-admitted
  sibling devices; Nostr relays remain the initial-contact and durable-backfill path
- **Reliable linked-device sync** as bounded records over TCP/FIPS service 7369;
  chat delivery and seen receipts remain end-to-end application signals

## Tech Stack

- Svelte 5, TypeScript, Vite
- UnoCSS
- NDK (Nostr Development Kit)
- nostr-pubsub over FIPS
- TCP/FIPS for ordered linked-device snapshots
- Workbox (service worker)

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Tests

```bash
pnpm test
pnpm test:e2e
```

To test device-sync packets and framing against a native checkout, run:

```sh
IRIS_CHAT_RS_CORE_DIR=/path/to/iris-chat-rs/core pnpm test:device-sync-interop
```

This compiles the selected checkout's protocol and framing code in a small Rust
fixture. Setting `IRIS_CHAT_RS_CORE_DIR` also enables these tests in `pnpm test`.

To verify messaging as well as device-sync against the native core used by iOS
and the other native apps, run:

```sh
IRIS_CHAT_RS_CORE_DIR=/path/to/iris-chat-rs/core pnpm test:interop
```

This requires a native checkout and runs the production web build against its
locked native CLI on isolated local message servers. It covers direct messages,
user-ID discovery, offline delivery and restart, linked devices, and groups
created by either app. Missing native source fails this command instead of
skipping the tests. The dedicated CI job checks out both apps and runs this gate.
This verifies the shared native core; it does not test a physical iPhone,
background notifications, or public message-server availability.

## Source

[View source on decentralized git](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat)
