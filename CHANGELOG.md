# Changelog

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
