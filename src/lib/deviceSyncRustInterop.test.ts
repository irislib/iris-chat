// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
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
