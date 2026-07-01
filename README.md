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

## Tech Stack

- Svelte 5, TypeScript, Vite
- UnoCSS
- NDK (Nostr Development Kit)
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

## Source

[View source on decentralized git](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat)
