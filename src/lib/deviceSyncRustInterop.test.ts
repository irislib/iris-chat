// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { getEventHash } from 'nostr-tools'
import type { OnEventMeta, Rumor } from 'nostr-double-ratchet'
import { createPrivateContactSync, editPrivateContact, parsePrivateContactControl, privateContactDocuments } from 'nostr-social-graph/privateContactSyncV2'
import { isChatMuteState } from './chatMuteSync'
import { isChatPinState } from './chatPinSync'
import type { DeviceState } from './devices'
import { registerPrivateControlEvents } from './privateControlEvents'
import { validPrivateDeviceLabel } from './privateDeviceLabelProtocol'
import {
  DEVICE_SYNC_MAX_PACKET_BYTES,
  DEVICE_SYNC_PAGE_MESSAGES,
  DEVICE_SYNC_PAGE_PACKETS,
  DEVICE_SYNC_PORT,
  DeviceSyncProtocolError,
  encodeDeviceSyncPacket,
  parseDeviceSyncPacket,
  type DeviceSyncSnapshot,
} from './deviceSyncProtocol'
import { frameRecord, RecordReader } from './deviceSyncTcp'

const appRoot = process.cwd()
const fixture = path.join(appRoot, 'test-fixtures/device-sync-rust')
const nativeSource = process.env.IRIS_CHAT_RS_CORE_DIR
const nativeCore = nativeSource && path.resolve(nativeSource)
const nativeAvailable = !!nativeCore && existsSync(path.join(nativeCore, 'src/core/device_sync.rs')) &&
  existsSync(path.join(nativeCore, 'src/core/device_sync_tcp.rs'))
const required = process.env.REQUIRE_DEVICE_SYNC_RUST_INTEROP === '1'
const binary = path.join(
  fixture,
  'target/debug',
  process.platform === 'win32' ? 'iris-chat-device-sync-fixture.exe' : 'iris-chat-device-sync-fixture',
)
const owner = 'a'.repeat(64)
const peer = 'b'.repeat(64)

const interop = required || nativeCore ? describe : describe.skip
const controlFixturePath = process.env.IRIS_PRIVATE_CONTROL_FIXTURE_INPUT
const controlInterop = required || process.env.REQUIRE_PRIVATE_CONTROL_INTEROP === '1' || controlFixturePath
  ? describe : describe.skip

// This input is emitted by the native Core test native_private_control_interop_fixture:
// real AppActions -> production builders -> queued 1060 -> sibling decryption.
// The legacy variants use the original Nostr EventBuilder, not handcrafted tags.
controlInterop('native-generated private control admission', () => {
  let controls: NativePrivateControls
  beforeAll(() => {
    if (!controlFixturePath) throw new Error('IRIS_PRIVATE_CONTROL_FIXTURE_INPUT must select the generated native Core fixture')
    controls = readNativePrivateControls(controlFixturePath)
    expect(controls.cases.map(entry => entry.kind).sort()).toEqual([10449, 10450, 10452, 10453])
  })

  it.each(['event', 'legacyEvent'] as const)('dispatches native %s controls through the production durable callback', async variant => {
    const received: Rumor[] = []
    const receiver = nativeControlReceiver(controls, async event => {
      assertNativeControlPayload(event, controls)
      received.push(event)
    })
    try {
      for (const entry of controls.cases) {
        const event = entry[variant]
        expect(event.kind).toBe(entry.kind)
        expect(event.id).toBe(getEventHash(event))
        expect(event.tags.filter(tag => tag[0] === 'p')).toEqual(variant === 'event' ? [['p', controls.owner]] : [])
        await receiver.deliver(event, controls.owner, receiver.meta)
      }
      expect(received.map(event => event.kind).sort()).toEqual([10449, 10450, 10452, 10453])
    } finally { receiver.stop() }
  })

  it('does not ACK a native control before the receiving device list is ready', async () => {
    const received: Rumor[] = []
    const receiver = nativeControlReceiver(controls, async event => { received.push(event) })
    try {
      receiver.state.isCurrentDeviceRegistered = false
      for (const entry of controls.cases) {
        await expect(receiver.deliver(entry.legacyEvent, controls.owner, receiver.meta)).rejects.toThrow('linked device list')
      }
      expect(received).toEqual([])
      receiver.state.isCurrentDeviceRegistered = true
      for (const entry of controls.cases) await receiver.deliver(entry.legacyEvent, controls.owner, receiver.meta)
      expect(received.map(event => event.kind).sort()).toEqual([10449, 10450, 10452, 10453])
    } finally { receiver.stop() }
  })

  it('does not admit an old native control under another account identity', async () => {
    const received: Rumor[] = []
    const receiver = nativeControlReceiver(controls, async event => { received.push(event) })
    try {
      for (const entry of controls.cases) {
        await receiver.deliver(entry.legacyEvent, controls.contact, { ...receiver.meta, senderOwnerPubkey: controls.contact })
      }
      expect(received).toEqual([])
    } finally { receiver.stop() }
  })
})

interop('iris-chat-rs device-sync interop', () => {
  beforeAll(() => {
    if (!nativeCore) throw new Error('IRIS_CHAT_RS_CORE_DIR must explicitly select the native source')
    if (!nativeAvailable) throw new Error(`iris-chat-rs core is missing at ${nativeCore}`)
    const build = spawnSync(
      'cargo',
      ['build', '--quiet', '--locked', '--manifest-path', path.join(fixture, 'Cargo.toml'),
        '--target-dir', path.join(fixture, 'target')],
      { cwd: appRoot, env: nativeEnv(), encoding: 'utf8', timeout: 120_000 },
    )
    if (build.status !== 0) throw new Error(build.error?.message || build.stderr || build.stdout || 'Rust fixture build failed')
  }, 120_000)

  it('extracts the service, record, page, and framing bounds from native source', () => {
    expect(JSON.parse(new TextDecoder().decode(runNative('contract')))).toEqual({
      port: DEVICE_SYNC_PORT,
      maxPacketBytes: DEVICE_SYNC_MAX_PACKET_BYTES,
      pageMessages: DEVICE_SYNC_PAGE_MESSAGES,
      pagePackets: DEVICE_SYNC_PAGE_PACKETS,
      frameHeaderBytes: 4,
    })
  })

  it('preserves native read state while retiring legacy private metadata on serialization', () => {
    const snapshot: DeviceSyncSnapshot = {
      v: 1, type: 'snapshot', rosterAt: 42,
      chats: [{ id: peer, updatedAt: 43 }], appKeys: [{ ownerPubkey: owner, createdAt: 42, devices: [{ identityPubkey: peer, createdAt: 40, deviceLabel: 'Study laptop', clientLabel: 'Iris Chat macOS', labelUpdatedAt: 43 }] }], groups: [], messages: [],
    }
    const nativeSnapshot = {
      ...snapshot,
      chats: [{
        ...snapshot.chats[0],
        readState: { updatedAtMs: 44000, deviceId: owner, seenThroughSecs: 43, seenAtBoundary: ['message-1'] },
        contactDetails: { nickname: 'Friend', note: 'Test contact', updatedAtMs: 44000 },
      }],
    }
    const nativeBytes = runNative('roundtrip', encodeDeviceSyncPacket(nativeSnapshot))
    const expected = { ...snapshot,
      appKeys: snapshot.appKeys.map(keys => ({ ...keys, devices: keys.devices.map(({ identityPubkey, createdAt }) => ({ identityPubkey, createdAt })) })),
      chats: [{ ...snapshot.chats[0], readState: nativeSnapshot.chats[0].readState }],
    }
    expect(JSON.parse(new TextDecoder().decode(nativeBytes))).toEqual(expected)
    expect(parseDeviceSyncPacket(nativeBytes, owner)).toEqual(expected)
  })

  it('preserves timed, forever, and unmuted states across native and web chat sync', () => {
    const snapshot: DeviceSyncSnapshot = {
      v: 1, type: 'snapshot', rosterAt: 100,
      appKeys: [], chats: [], groups: [], messages: [],
      chatPins: [{ chatId: peer, pinned: true, updatedAtMs: 1_800_000_000_001 }, { chatId: owner, pinned: false, updatedAtMs: 1_800_000_000_002 }],
      chatMutes: [
        { chatId: peer, untilSecs: 1_900_000_000, updatedAtMs: 1_800_000_000_001 },
        { chatId: 'group:friends', untilSecs: 0, updatedAtMs: 1_800_000_000_002 },
        { chatId: owner, untilSecs: null, updatedAtMs: 1_800_000_000_003 },
      ],
    }
    const nativeBytes = runNative('roundtrip', encodeDeviceSyncPacket(snapshot))
    expect(parseDeviceSyncPacket(nativeBytes, owner)).toEqual(snapshot)
  })

  it('preserves private contact registers and explicit clears across native and web sync', () => {
    const initial = editPrivateContact(createPrivateContactSync(owner, '1'.repeat(32)), peer, {
      favorite: true, muted: true, nickname: 'Café friend', note: 'Meet tomorrow\nBring tea ☕',
    })
    const cleared = editPrivateContact(initial, peer, { favorite: false, muted: false, nickname: null, note: null })
    for (const state of [initial, cleared]) {
      const snapshot: DeviceSyncSnapshot = {
        v: 1, type: 'snapshot', rosterAt: 100,
        appKeys: [], chats: [], groups: [], messages: [],
        privateContactsV2: privateContactDocuments(state),
        privateDeviceLabelsV2: [{ type: 'device-labels', v: 2, owner, device: peer,
          deviceLabel: '💚 tablet', clientLabel: null, updatedAtSecs: 1 }],
      }
      const nativeBytes = runNative('roundtrip', encodeDeviceSyncPacket(snapshot))
      expect(JSON.parse(new TextDecoder().decode(nativeBytes))).toEqual(snapshot)
      expect(parseDeviceSyncPacket(nativeBytes, owner)).toEqual(snapshot)
    }
  })

  it('agrees with Rust when rejecting a negative private contact register counter', () => {
    const documents = privateContactDocuments(editPrivateContact(
      createPrivateContactSync(owner, '1'.repeat(32)), peer, { favorite: true },
    ))
    documents[0].fields.favorite!.counter = -1
    const payload = encodeDeviceSyncPacket({
      v: 1, type: 'snapshot', rosterAt: 100,
      appKeys: [], chats: [], groups: [], messages: [], privateContactsV2: documents,
    })
    expect(invokeNative('roundtrip', payload).status).not.toBe(0)
    expect(() => parseDeviceSyncPacket(payload, owner)).toThrow(DeviceSyncProtocolError)
  })

  it('lets Rust decode TS and TS decode Rust for every paged packet shape', () => {
    const snapshot: DeviceSyncSnapshot = {
      v: 1,
      type: 'snapshot',
      rosterAt: 42,
      chats: [{ id: peer, updatedAt: 43 }],
      appKeys: [{
        ownerPubkey: owner,
        createdAt: 42,
        devices: [{ identityPubkey: peer, createdAt: 41 }],
      }],
      groups: [{
        id: 'group-1',
        name: 'Native and browser',
        description: 'Linked devices',
        picture: 'https://example.com/group.png',
        createdBy: owner,
        members: [owner, peer],
        admins: [owner],
        protocol: 'sender_key_v1',
        revision: 2,
        createdAt: 40,
        updatedAt: 43,
        accepted: true,
      }],
      messages: [{
        chatId: peer,
        id: 'message-1',
        body: '\uFEFFnative ↔ browser 🌈',
        author: owner,
        createdAt: 43,
        expiresAt: 100,
      }],
    }
    const rustSnapshot = runNative('roundtrip', encodeDeviceSyncPacket(snapshot))
    expect(parseDeviceSyncPacket(rustSnapshot, owner)).toEqual(snapshot)

    const rustPackets = [
      { v: 1, type: 'request', rosterAt: 42, page: { kind: 'metadata', offset: 32 } },
      { v: 1, type: 'request', rosterAt: 42, page: { kind: 'messages', after: null } },
      { v: 1, type: 'resyncRequired' },
      {
        v: 1,
        type: 'pageEnd',
        rosterAt: 42,
        next: { kind: 'messages', after: { createdAt: 43, chatId: peer, id: 'message-1' } },
      },
    ]
    for (const packet of rustPackets) {
      const emitted = runNative('roundtrip', new TextEncoder().encode(JSON.stringify(packet)))
      expect(parseDeviceSyncPacket(emitted, owner)).toEqual(packet)
    }
  })

  it.each(['YR==', 'YWJ=', 'YQ', 'YQ==\n', '/w=='])(
    'agrees with Rust when rejecting malformed base64 UTF-8 %j', (body: string) => {
      const payload = new TextEncoder().encode(JSON.stringify({
        v: 1,
        type: 'snapshot',
        rosterAt: 42,
        messages: [{ chatId: peer, id: 'm', body, author: owner, createdAt: 43 }],
      }))
      expect(invokeNative('roundtrip', payload).status).not.toBe(0)
      expect(() => parseDeviceSyncPacket(payload, owner)).toThrow(DeviceSyncProtocolError)
    },
  )

  it('interchanges split u32-BE records in both directions', () => {
    const packet = encodeDeviceSyncPacket({ v: 1, type: 'request', rosterAt: 42 })
    const decodedByRust = runNative('read', frameRecord(packet), ['3'])
    expect(parseDeviceSyncPacket(decodedByRust, owner)).toEqual({
      v: 1,
      type: 'request',
      rosterAt: 42,
    })

    const framedByRust = runNative('frame', packet)
    const reader = new RecordReader(DEVICE_SYNC_MAX_PACKET_BYTES)
    expect(reader.push(framedByRust.slice(0, 5))).toEqual([])
    const records = reader.push(framedByRust.slice(5))
    reader.finish()
    expect(records).toHaveLength(1)
    expect(parseDeviceSyncPacket(records[0], owner)).toEqual({
      v: 1,
      type: 'request',
      rosterAt: 42,
    })
  })

  it('rejects a truncated Rust stream instead of emitting a packet', () => {
    const packet = encodeDeviceSyncPacket({ v: 1, type: 'request', rosterAt: 42 })
    const result = invokeNative('read', frameRecord(packet).slice(0, -1), ['2'])
    expect(result.status).not.toBe(0)
    expect(result.stdout.byteLength).toBe(0)
  })
})

function nativeEnv(): NodeJS.ProcessEnv {
  if (!nativeCore) throw new Error('IRIS_CHAT_RS_CORE_DIR is required')
  return { ...process.env, IRIS_CHAT_RS_CORE_DIR: nativeCore }
}

function invokeNative(operation: string, input?: Uint8Array, args: string[] = []) {
  return spawnSync(binary, [operation, ...args], {
    cwd: appRoot,
    env: nativeEnv(),
    input,
    encoding: null,
  })
}

function runNative(operation: string, input?: Uint8Array, args: string[] = []): Uint8Array {
  const result = invokeNative(operation, input, args)
  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || `native fixture ${operation} failed`)
  }
  return new Uint8Array(result.stdout)
}

interface NativePrivateControls {
  owner: string
  senderDevice: string
  recipientDevice: string
  contact: string
  cases: { kind: number; event: Rumor; legacyEvent: Rumor }[]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readNativePrivateControls(file: string): NativePrivateControls {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const pubkey = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  if (!record(value) || value.version !== 1 || !pubkey(value.owner) || !pubkey(value.senderDevice) ||
    !pubkey(value.recipientDevice) || !pubkey(value.contact) || !Array.isArray(value.cases)) {
    throw new Error('Invalid generated native private-control fixture')
  }
  const cases = value.cases.map((entry: unknown) => {
    if (!record(entry) || typeof entry.kind !== 'number') throw new Error('Invalid native control case')
    return { kind: entry.kind, event: readNativeRumor(entry.event), legacyEvent: readNativeRumor(entry.legacyEvent) }
  })
  return { owner: value.owner, senderDevice: value.senderDevice, recipientDevice: value.recipientDevice, contact: value.contact, cases }
}

function readNativeRumor(value: unknown): Rumor {
  if (!record(value) || typeof value.id !== 'string' || typeof value.pubkey !== 'string' ||
    typeof value.kind !== 'number' || typeof value.created_at !== 'number' ||
    typeof value.content !== 'string' || !Array.isArray(value.tags)) throw new Error('Invalid native rumor')
  const tags = value.tags.map((tag: unknown) => {
    if (!Array.isArray(tag) || !tag.every((item: unknown): item is string => typeof item === 'string')) {
      throw new Error('Invalid native rumor tag')
    }
    return tag
  })
  return { id: value.id, pubkey: value.pubkey, kind: value.kind, created_at: value.created_at, content: value.content, tags }
}

function nativeControlReceiver(controls: NativePrivateControls, receive: (event: Rumor) => Promise<void>) {
  const state: DeviceState = {
    identityPubkey: controls.recipientDevice,
    registeredDevices: [controls.senderDevice, controls.recipientDevice].map(identityPubkey => ({ identityPubkey, createdAt: 1 })),
    isCurrentDeviceRegistered: true, appKeysManagerReady: true, sessionManagerReady: true,
    hasLocalAppKeys: true, lastEventTimestamp: 1,
  }
  const meta: OnEventMeta = {
    senderOwnerPubkey: controls.owner, senderDevicePubkey: controls.senderDevice,
    fromDeviceId: controls.senderDevice, isSelf: true, isCrossDeviceSelf: true,
  }
  let deliver: (event: Rumor, from: string, meta?: OnEventMeta) => Promise<void> = async () => { throw new Error('Durable callback was not registered') }
  const stop = registerPrivateControlEvents({
    onDurableSessionEvent(kinds, callback) {
      expect([...kinds].sort()).toEqual([10449, 10450, 10452, 10453])
      deliver = callback
      return () => {}
    },
    refreshOwnAppKeysFromRelay: async () => false,
  }, { account: controls.owner, getAccount: () => controls.owner, getState: () => state, receive })
  return { deliver, stop, state, meta }
}

function assertNativeControlPayload(event: Rumor, controls: NativePrivateControls): void {
  const value: unknown = JSON.parse(event.content)
  if (event.kind === 10452) {
    const control = parsePrivateContactControl(value, controls.owner)
    expect(control.type).toBe('private-contact-sync')
    if (control.type !== 'private-contact-sync') throw new Error('Expected a native contact update')
    expect(control.document.contact).toBe(controls.contact)
    expect(control.document.fields.favorite?.value).toBe(true)
    expect(control.document.fields.nickname?.value).toBe('Fixture friend')
    expect(control.document.fields.note?.value).toBe('Fixture note')
  } else if (event.kind === 10453) {
    expect(validPrivateDeviceLabel(value, controls.owner)).toBe(true)
    expect(value).toMatchObject({ device: controls.senderDevice, deviceLabel: 'Fixture phone', clientLabel: 'Iris Chat' })
  } else {
    if (!record(value)) throw new Error('Expected a native chat setting')
    if (event.kind === 10449) {
      expect(value).toMatchObject({ type: 'chat-mute', v: 1, mute: { chatId: controls.contact, untilSecs: 0 } })
      expect(isChatMuteState(value.mute)).toBe(true)
    } else {
      expect(event.kind).toBe(10450)
      expect(value).toMatchObject({ type: 'chat-pin', v: 1, pin: { chatId: controls.contact, pinned: true } })
      expect(isChatPinState(value.pin)).toBe(true)
    }
  }
}
