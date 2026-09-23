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
- **Voice and video calls** use WebRTC codecs and adaptive bitrate, with signaling
  and encrypted media packets carried over authenticated FIPS links

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

## Call servers

Calls work in a standalone browser through existing FIPS nodes. No media server,
TURN gateway, native helper, or extra FIPS-node feature is required. Opus audio
and H.264 video are encoded locally, then sent inside authenticated FIPS
connections to accepted contacts. Browser video support is checked before
capture; audio loss concealment uses bundled libopus 1.6.1. All codec assets
are served with the app. To rebuild the bundled codec, run
`scripts/opus/build.sh` (requires CMake and downloads pinned build tools).

Missed, answered, canceled, and declined calls appear in the chat with their
direction and duration. Call history stays on this device and survives reloads.

Call quality can be changed in Settings or during a video call. Automatic
quality caps video at 2 Mbps, High quality at 4 Mbps, and Use less data at
400 kbps. Custom accepts 100–8000 kbps. The encoder reduces its rate when
receivers report loss and increases it as the connection recovers. Automatic
requests 720p30; High requests 1080p30, subject to the camera and codec.

For offline calls, load or host the app locally, pair the contacts, and use a
reachable local FIPS WebSocket node in Settings → Call servers. Pairing needs
a reachable local message server; established calls continue after that
server stops. Microphone/camera access requires a secure browser context:
HTTPS with a trusted certificate, or localhost for a same-computer test. Plain
HTTP on another computer's LAN address is insufficient. Public STUN servers
(the same Google and Cloudflare defaults as Iris Drive) help FIPS establish
direct connections across NAT. They do not carry call media. Gathering is
limited to two seconds, so unavailable STUN does not prevent local connections
or existing FIPS routes. No TURN or media service is used. Saved connection
settings may set `stunServers: []` for local-only address gathering.

Run the browser call check with Internet HTTP/WebSocket traffic blocked,
unanswered local STUN, and both bootstrap servers stopped during the call:

```sh
pnpm test:e2e e2e/calls.spec.ts --workers=1 --retries=0
node scripts/test-call-codecs.mjs # Chromium + WebKit codecs, 1080p, Opus loss concealment
```

## Tests

```bash
pnpm test
pnpm test:e2e
```

The locked FIPS core has a small pnpm patch for concurrent session setup and
reordered handshake traffic. `fipsSessionConcurrency.test.ts` exercises the
installed runtime with real Noise handshakes, including stalled-send timeouts.
The same bounded patch compares authenticated peer identities by their full
x-only key while preserving the actual compressed keys in Noise. `fipsIdentityParity.test.ts` covers real even/odd-key link
replacement and session rekey handshakes, including different-identity rejection.

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
