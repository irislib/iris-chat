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

## Invitations

New private invitations use `https://chat.iris.to/#/nhash1…`. The standard encrypted
hashtree reference contains the ciphertext hash and decryption key. Its single
CHK-encrypted JSON leaf carries the version, display name, random nonce, and
existing authenticated double-ratchet invitation fields. Public, unkeyed invite
records are rejected. Fragments keep the reference out of HTTP requests to the
landing page. Anyone holding a private link can read its record and use it.

Personal invitations remain reusable. New JSON invitation links include the
current handshake version. Older issued links remain stored locally but must be
replaced before sharing. Public contact links use
`/#/npub1…` and the existing public device-invite discovery flow.

Group records additionally contain a group ID and random admission token, with
optional expiry and maximum uses. They never contain group message keys. The
joiner establishes an authenticated pairwise session and sends encrypted kind
10461 with `{v:1, groupId, token}`. Only the issuing admin's device owns that
link's admission ledger. It checks current admin authority, revocation, expiry,
and use count, then commits the membership and distinct-owner use atomically.
Retries do not consume another use; a removed member cannot reuse that token.
Encrypted kind 10462 returns the same fields plus `status` (`added`,
`already-member`, `used`, `unavailable`, `expired`, or `full`). The joiner accepts
results only from the owner and device pinned in its invitation. Group state and
sender keys follow the existing authenticated group protocol.

The default is unlimited uses with a 30-day expiry; the UI also offers 1, 10 or
100 uses and revocation. Requests queue while the issuing device is offline.
Links and counters are device-local; other admins can issue independent links.
Clearing that device's data retires its links. Native apps also create private
personal and group links using the same required handshake version.
The shared wire fixture is checked by both apps;
`e2e/invite-roleplay.spec.ts` and the private-invite case in
`e2e/ndr-interop.spec.ts` exercise admission and real messaging.

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
pnpm bench:calls # Sustained Chromium + WebKit bandwidth/latency/decoder benchmark
```

The bitrate benchmark runs production `BrowserCallMedia` and `CallSession` with
real H.264/Opus codecs and moving synthetic camera input. A bounded datagram
link shares 256/400/800 kbps between audio, video, control packets, repairs,
and an allowance for encryption/network overhead. It also checks asymmetric
links, recovery, 1% packet loss, jitter, and missing feedback. The last five
seconds of each phase must sustain at least 8 decoded fps and 30 audio frames
per second, p95 frame age under 400 ms, and no freeze longer than 1.5 seconds.
Recovery must exceed 500 kbps. JSON measurements go to `work/calls/bitrate-bench.json`.
Use `pnpm bench:calls chromium` or `webkit` for one engine, on an otherwise idle
host. The separate browser call check above exercises actual encrypted FIPS
transport and measures sustained video/audio delivery during a bandwidth cap.
These local synthetic tests do not measure physical camera/display or Wi-Fi latency.

## Tests

Private communication must preserve metadata privacy as well as forward secrecy.
Relay events and notification requests must never expose both participants'
identities through signers, tags, filters, authentication, or correlations between
them. Prefer session and invite keys. A recipient device tag is allowed only when
needed for delivery and the sender uses an unlinkable session key; invite responses
target the invite's ephemeral key. Authenticate callers and apply contact rules
locally after ratchet decryption. FIPS remains available for live traffic.

Call wake envelopes use a fresh disposable signing key and carry only existing
double-ratchet ciphertext and invite responses. Never use an account or device
key to sign them. Old identity-bearing wakes and messages from pre-privacy-version
sessions remain blocked on queue restart; their local records are preserved.
`callPush.test.ts` and `nostrWorkerRuntime.test.ts` inspect the actual wire data
and retry path and are required by the site release gate. Encryption/decryption
tests alone cannot establish metadata privacy.

```bash
pnpm test
pnpm test:e2e
```

Physical Android interop is opt-in: run `pnpm test:android-interop`. It uses
`iris-chat-rs/scripts/native_lab.py` to check device health and reserve the phone
for the entire run. Set `IRIS_NATIVE_LAB_SCRIPT` if that repository is elsewhere;
`IRIS_CHAT_RS_ANDROID_SERIAL` selects a particular device. Ordinary browser tests
do not probe or launch attached phones.

Physical iPhone linking with history is a separate public-network gate:

```sh
IRIS_CHAT_RS_DIR=/path/to/iris-chat-rs IRIS_LINK_TEST_UDID=<selected-physical-iphone> pnpm test:public-device-link
```

Build that native checkout's physical iPhone development test products first.
The test reserves the selected phone, creates an isolated account and a fresh
Chrome profile, approves linking with history, and requires a message written
before linking to appear exactly once after browser reload. It uses the public
message and FIPS servers; local interop passes do not substitute for this gate.
`IRIS_LINK_TEST_URL` selects a candidate preview; the default is `chat.iris.to`.
Private diagnostics stay in `work/public-device-link/`. Ordinary phone storage
is preserved and the development app is relaunched normally afterward.

Chat uses the shared FIPS runtime without application-local patches. Its session
setup, identity, transport handover, and WebRTC negotiation regressions are
covered in `fips-ts` and checked against the installed packages here. These
include real Noise handshakes, stalled-send timeouts, canceled negotiations,
and continued delivery after a carrier disconnects. Authenticated identities
use the full x-only key while Noise preserves the actual compressed keys;
different identities remain rejected.

Call offers use verified contact device addresses over FIPS while direct
connection attempts proceed independently. STUN defaults and the bounded
gathering timeout come from the shared WebRTC transport.

To test device-sync packets and framing against a native checkout, run:

```sh
export IRIS_CHAT_RS_CORE_DIR=/path/to/iris-chat-rs/core
mkdir -p work/private-controls
export IRIS_PRIVATE_CONTROL_FIXTURE_INPUT="$PWD/work/private-controls/native-private-controls.json"
export IRIS_PRIVATE_STATE_FIXTURE_INPUT="$PWD/work/private-controls/native-private-state.json"
IRIS_PRIVATE_CONTROL_FIXTURE_OUTPUT="$IRIS_PRIVATE_CONTROL_FIXTURE_INPUT" \
  cargo test --locked --manifest-path "$IRIS_CHAT_RS_CORE_DIR/Cargo.toml" --lib native_private_control_interop_fixture
IRIS_PRIVATE_STATE_FIXTURE_OUTPUT="$IRIS_PRIVATE_STATE_FIXTURE_INPUT" \
  cargo test --locked --manifest-path "$IRIS_CHAT_RS_CORE_DIR/Cargo.toml" --lib private_contacts_negentropy_repairs_dropped_snapshots_and_exports_interop
pnpm test:device-sync-interop
```

This compiles the selected checkout's protocol and framing code in a small Rust
fixture and checks data generated through the native app's encrypted device
queue and Negentropy reconciliation. Keep these variables set when running
`pnpm test` or `pnpm test:interop` against that checkout.

Both apps store nicknames, notes, favorites and notification mutes as unsigned
private contact facts from `nostr-social-graph`. Field clocks, explicit clears
and pending edits survive migration. Facts reconcile only between authenticated
own devices; encrypted V2 controls keep older devices compatible. Public
publication rejects these facts and private controls. Name approvals, block
intervals and private settings also use unsigned private events admitted only
from authenticated own devices. Exact message-read markers use the same native
schemas and capability negotiation, with private state applied before history.
Device and group authorization proofs retain their original signatures.

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
