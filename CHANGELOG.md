# Changelog

## Unreleased

## 2.6.16 - 2026-07-20

- Default delivery receipts, read receipts, and typing indicators to off while
  keeping each available as an explicit privacy setting; apply the typing
  preference to group chats as well as direct chats.
- Upgrade the shared browser pubsub runtime to `nostr-pubsub` 0.5.1 and pass
  the compressed local FIPS identity required by its reliable TCP
  `REQ`/`INV`/`WANT`/`EVENT` transport.
- Upgrade to FIPS TypeScript runtime 0.0.29, negotiating direct FSP only with
  capable peers while retaining routed FSP compatibility with upstream FIPS
  0.4.1 and older runtimes.

## 2.6.15 - 2026-07-17

- Upgrade the shared authenticated `nostr.pubsub/1` client to immutable
  `nostr-pubsub` 0.3.1 so browser subscriptions recover after a temporarily
  unavailable FIPS route reconnects.
- Preserve explicit peer admission, bounded replay, the 65,525-byte FSP
  datagram limit, and the separate device-sync v1 transport unchanged.

## 2.6.14 - 2026-07-16

- Upgrade the browser to immutable Hashtree core 0.3.0, sharing the native
  `BlobRoute` request/result/context boundary without changing the device-sync
  port, v1 JSON variants, 64 KiB record bound, or pagination.

## 2.6.13 - 2026-07-16

- Pin the immutable FIPS TypeScript 0.0.26 runtime, preserving browser identity
  across reloads and rejecting stale handshake epochs.
- Align browser device sync with the unchanged Iris Chat 0.1.39 native v1
  protocol at canonical source `6514f424fc16b0d435a22a98081fc4569c15ad2a`
  and its real Rust process fixture.
- Carry signed Nostr events only through the shared authenticated
  `nostr.pubsub/1` transport; device-sync records remain on FIPS TCP port 7369.
