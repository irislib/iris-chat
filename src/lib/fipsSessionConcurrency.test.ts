// @vitest-environment node
// Audits the installed shared FIPS runtime through real Noise handshakes.
import { afterEach, describe, expect, it, vi } from "vitest";

import { toHex } from "../../node_modules/@fips/core/dist/codec/hex.js";
import {
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_PHASE_ESTABLISHED,
  peekFspPhase,
} from "../../node_modules/@fips/core/dist/fsp/wire.js";
import { FspSession } from "../../node_modules/@fips/core/dist/fsp/session.js";
import { identityFromSecretKey } from "../../node_modules/@fips/core/dist/identity/index.js";
import { FspSessionManager } from "../../node_modules/@fips/core/dist/node/FspSessionManager.js";
import type { FipsRouting } from "../../node_modules/@fips/core/dist/node/FipsRouting.js";
import type { AdjacentPeer } from "../../node_modules/@fips/core/dist/node/PeerState.js";

type RoutedPayload = Parameters<FipsRouting["sendFspToward"]>[1];
const routedFrames = (payload: RoutedPayload, nextHop: AdjacentPeer): Uint8Array[] =>
  typeof payload === "function" ? payload(nextHop) : [payload];

afterEach(() => {
  vi.useRealTimers();
});

describe("FspSessionManager", () => {
  it("delivers a direct record that arrives before the routed final handshake", async () => {
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x31));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x72));
    const sentReplies: Uint8Array[] = [];
    const delivered: Uint8Array[] = [];
    const routing = {
      coords: [responderIdentity.nodeAddr],
      learnReverseRoute: () => {},
      sendFspReplyToward: async (
        _remoteNodeAddr: Uint8Array,
        frame: Uint8Array,
      ) => {
        sentReplies.push(new Uint8Array(frame));
      },
    };
    const manager = new FspSessionManager({
      identity: responderIdentity,
      random: { bytes: (length: number) => new Uint8Array(length).fill(0x44) },
      localEpoch: new Uint8Array(8).fill(0x55),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      routing: routing as never,
      getPeerByNodeAddr: () => undefined,
      emitDatagram: () => {},
      emitEndpointData: () => {},
      handleLinkNegotiation: async () => {},
      emitSession: () => {},
    });
    manager.registerService(4_242, ({ payload }) => {
      delivered.push(new Uint8Array(payload));
    });
    const peer = {
      pubkey: initiatorIdentity.publicKey,
      pubkeyHex: "",
      remoteAddr: { transport: "memory", addr: "initiator" },
    } as never;
    const initiator = new FspSession({
      identity: initiatorIdentity,
      role: "initiator",
      remotePubkey: responderIdentity.publicKey,
      localEpoch: new Uint8Array(8).fill(0x66),
    });

    const setup = initiator.buildSessionSetup(
      (length) => new Uint8Array(length),
      initiatorIdentity.nodeAddr,
      responderIdentity.nodeAddr,
    );
    await manager.handleFromPeer(peer, initiatorIdentity.nodeAddr, setup);
    const msg3 = initiator.handleSessionAck(
      sentReplies[0]!,
      (length) => new Uint8Array(length),
    );
    const payload = new TextEncoder().encode("first pubsub record");
    const earlyRecord = initiator.encryptDatagram({
      srcPort: 5_000,
      dstPort: 4_242,
      payload,
    }, FSP_FLAG_DIRECT_TRANSPORT);

    await expect(
      manager.handleFromPeer(peer, initiatorIdentity.nodeAddr, earlyRecord),
    ).resolves.toBeUndefined();
    expect(delivered).toEqual([]);

    await manager.handleFromPeer(peer, initiatorIdentity.nodeAddr, msg3);
    expect(delivered).toEqual([payload]);
  });

  it("shares a setup timeout and replaces it before the next send attempt", async () => {
    vi.useFakeTimers();
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x23));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x67));
    let completeSetup = false;
    let setupAttempts = 0;
    const setups: Uint8Array[] = [];
    let responder: FspSession | undefined;
    const peer = {
      pubkey: responderIdentity.publicKey,
      pubkeyHex: "",
      remoteAddr: { transport: "memory", addr: "responder" },
    } as never;
    const routing = {
      coords: [initiatorIdentity.nodeAddr],
      coordinatesFor: () => [responderIdentity.nodeAddr],
      learnReverseRoute: () => {},
      sendFspToward: async (_remoteNodeAddr: Uint8Array, payload: RoutedPayload) => {
        for (const frame of routedFrames(payload, peer)) {
          const phase = peekFspPhase(frame);
          if (phase === 1) {
            setupAttempts += 1;
            setups.push(new Uint8Array(frame));
            if (!completeSetup) return;
            responder = new FspSession({
              identity: responderIdentity,
              role: "responder",
              localEpoch: new Uint8Array(8).fill(0x77),
            });
            const ack = responder.handleSessionSetup(
              frame,
              (length) => new Uint8Array(length).fill(0x31),
              responderIdentity.nodeAddr,
            );
            await manager.handleFromPeer(peer, responderIdentity.nodeAddr, ack);
            continue;
          }
          if (phase === 3) {
            responder?.handleSessionMsg3(frame);
            continue;
          }
          expect(phase).toBe(FSP_PHASE_ESTABLISHED);
          expect(responder?.decryptIncoming(frame).data?.payload).toEqual(new Uint8Array([1, 2, 3]));
        }
      },
    };
    const manager = new FspSessionManager({
      identity: initiatorIdentity,
      random: { bytes: (length: number) => new Uint8Array(length).fill(0x42) },
      localEpoch: new Uint8Array(8).fill(0x52),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      routing: routing as never,
      getPeerByNodeAddr: () => undefined,
      emitDatagram: () => {},
      emitEndpointData: () => {},
      handleLinkNegotiation: async () => {},
      emitSession: () => {},
    });
    const datagram = {
      dst: toHex(responderIdentity.publicKey),
      dstPort: 4_242,
      payload: new Uint8Array([1, 2, 3]),
    };

    const firstSend = expect(manager.sendDatagram(datagram))
      .rejects.toThrow("FSP handshake timeout");
    const concurrentSend = expect(manager.sendDatagram(datagram))
      .rejects.toThrow("FSP handshake timeout");
    await vi.advanceTimersByTimeAsync(0);
    expect(setupAttempts).toBe(1);
    // Concurrent callers share one Noise setup and its bounded 1/3/7s retries.
    for (const [delay, attempts] of [[1_000, 2], [2_000, 3], [4_000, 4]] as const) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(setupAttempts).toBe(attempts);
      expect(setups.at(-1)).toEqual(setups[0]);
    }
    await vi.advanceTimersByTimeAsync(8_000);
    await Promise.all([firstSend, concurrentSend]);
    expect(setupAttempts).toBe(4);
    completeSetup = true;

    await expect(manager.sendDatagram(datagram)).resolves.toBeUndefined();
    expect(setupAttempts).toBe(5);
    expect(responder?.state).toBe("established");
  });
  it("keeps an incoming handshake created while an outgoing route lookup waits", async () => {
    vi.useFakeTimers();
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x38));
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x62));
    let releaseRoute!: () => void;
    const routeReady = new Promise<void>(resolve => { releaseRoute = resolve; });
    const sent: Uint8Array[] = [];
    const peer = { pubkey: remote.publicKey, pubkeyHex: toHex(remote.publicKey),
      remoteAddr: { transport: "memory", addr: "remote" } } as never;
    const manager = new FspSessionManager({
      identity: local,
      random: { bytes: length => new Uint8Array(length).fill(0x43) },
      localEpoch: new Uint8Array(8).fill(0x53),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      routing: {
        coords: [local.nodeAddr], coordinatesFor: () => undefined,
        ensureFirstContactRoute: () => routeReady, learnReverseRoute: () => {},
        sendFspReplyToward: async (_: unknown, frame: Uint8Array) => { sent.push(frame); },
        sendFspToward: async (_: unknown, payload: RoutedPayload) => { sent.push(...routedFrames(payload, peer)); },
      } as never,
      getPeerByNodeAddr: () => undefined, emitDatagram: () => {}, emitEndpointData: () => {},
      handleLinkNegotiation: async () => {}, emitSession: () => {},
    });
    const payload = new Uint8Array([17, 23, 41]);
    let outgoingDone = false;
    const outgoing = manager.sendDatagram({ dst: toHex(remote.publicKey), dstPort: 4_242, payload })
      .then(() => { outgoingDone = true; }).catch(() => {});
    const initiator = new FspSession({ identity: remote, role: "initiator", remotePubkey: local.publicKey,
      localEpoch: new Uint8Array(8).fill(0x67) });
    try {
      await manager.handleFromPeer(peer, remote.nodeAddr, initiator.buildSessionSetup(
        length => new Uint8Array(length), remote.nodeAddr, local.nodeAddr));
      const msg3 = initiator.handleSessionAck(sent[0]!, length => new Uint8Array(length));
      releaseRoute();
      await vi.advanceTimersByTimeAsync(0);
      // Resolving the route must reuse the responder, never send a competing Msg1.
      expect(sent.map(peekFspPhase)).toEqual([2]);
      await manager.handleFromPeer(peer, remote.nodeAddr, msg3);
      await vi.advanceTimersByTimeAsync(0);
      expect(outgoingDone).toBe(true);
      const encrypted = sent.find(frame => peekFspPhase(frame) === FSP_PHASE_ESTABLISHED)!;
      expect(initiator.decryptIncoming(encrypted).data?.payload).toEqual(payload);
    } finally {
      releaseRoute();
      await vi.advanceTimersByTimeAsync(15_000);
      manager.stop();
      await outgoing;
    }
  });

  it("observes the setup timeout while the initial transport send is stalled", async () => {
    vi.useFakeTimers();
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x41));
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x59));
    let releaseSend!: () => void;
    const sendReady = new Promise<void>(resolve => { releaseSend = resolve; });
    const manager = new FspSessionManager({
      identity: local, random: { bytes: length => new Uint8Array(length).fill(0x37) },
      localEpoch: new Uint8Array(8).fill(0x54),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      routing: { coords: [local.nodeAddr], coordinatesFor: () => [remote.nodeAddr],
        sendFspToward: () => sendReady } as never,
      getPeerByNodeAddr: () => undefined, emitDatagram: () => {}, emitEndpointData: () => {},
      handleLinkNegotiation: async () => {}, emitSession: () => {},
    });
    const outcome = manager.sendDatagram({ dst: toHex(remote.publicKey), dstPort: 4_242,
      payload: new Uint8Array([1]) }).then(() => "sent", error => (error as Error).message);
    // Vitest also fails this test if setupDone rejects without an observer
    // during the stalled carrier write, before ensureSession can await it.
    await vi.advanceTimersByTimeAsync(15_000);
    releaseSend();
    expect(await outcome).toBe("FSP handshake timeout");
    manager.stop();
  });

});
