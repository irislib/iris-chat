# Changelog

## Unreleased

## 2.6.18 - 2026-09-05

- Find followed people and pasted user IDs with verified messaging support,
  including cached results when message servers are unavailable.
- Show published device counts and local encrypted session counts on user
  profiles, with active and older sessions available in the details.
- Keep revoked devices hidden when older device information arrives later.

## 2.6.17 - 2026-09-05

- Preserve leading Unicode byte-order marks in synced messages and reject
  malformed base64 consistently with the native app.
- Upgrade double ratchet to 0.0.167, fixing delayed messages becoming unreadable
  after encryption keys rotate or a session is restored.
- Test device-sync interoperability against explicitly selected native source,
  reuse supplied native executables in browser tests, and use the configured
  test origin for invites and notification permissions.

## 2.6.16 - 2026-07-20

- Consolidate duplicated delivery tracking, group mutations, persisted
  settings, and reactive UI state while preserving the existing messaging and
  release behavior with less runtime code.
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
