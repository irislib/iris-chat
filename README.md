# iris chat

Decentralized encrypted messaging over Nostr using the double-ratchet protocol.

## Features

- **End-to-end encryption** via [nostr-double-ratchet](https://github.com/mmalmi/nostr-double-ratchet)
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

## Source

[View source on iris files](https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/iris-chat)
