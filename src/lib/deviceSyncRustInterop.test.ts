import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEVICE_SYNC_MAX_PACKET_BYTES,
  DEVICE_SYNC_PAGE_MESSAGES,
  DEVICE_SYNC_PAGE_PACKETS,
  DEVICE_SYNC_PORT,
  encodeDeviceSyncPacket,
  parseDeviceSyncPacket,
  type DeviceSyncSnapshot,
} from './deviceSyncProtocol'
import { frameRecord, RecordReader } from './deviceSyncTcp'

const appRoot = process.cwd()
const fixture = path.join(appRoot, 'test-fixtures/device-sync-rust')
const nativeCore = process.env.IRIS_CHAT_RS_CORE_DIR ?? path.resolve(appRoot, '../iris-chat-rs/core')
const nativeRepo = path.resolve(nativeCore, '..')
const NATIVE_SOURCE_SHA = '80cf8266ca2f8e2cb2a422f42405a25e9a33f80d'
const nativeAvailable = existsSync(path.join(nativeCore, 'src/core/device_sync.rs')) &&
  existsSync(path.join(nativeCore, 'src/core/device_sync_tcp.rs'))
const required = process.env.REQUIRE_DEVICE_SYNC_RUST_INTEROP === '1'
const binary = path.join(
  fixture,
  'target/debug',
  process.platform === 'win32' ? 'iris-chat-device-sync-fixture.exe' : 'iris-chat-device-sync-fixture',
)
const owner = 'a'.repeat(64)
const peer = 'b'.repeat(64)

const interop = required ? describe : describe.skip

interop('iris-chat-rs 0.1.38 device-sync interop', () => {
  beforeAll(() => {
    if (!nativeAvailable) throw new Error(`iris-chat-rs core is missing at ${nativeCore}`)
    requireReleasedNativeSource()
    const build = spawnSync(
      'cargo',
      ['build', '--quiet', '--locked', '--manifest-path', path.join(fixture, 'Cargo.toml')],
      { cwd: appRoot, env: nativeEnv(), encoding: 'utf8' },
    )
    if (build.status !== 0) throw new Error(build.stderr || build.stdout || 'Rust fixture build failed')
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
      chats: [],
      appKeys: [],
      groups: [],
      messages: [{
        chatId: peer,
        id: 'message-1',
        body: 'native ↔ browser 🌈',
        author: owner,
        createdAt: 43,
      }],
    }
    const rustSnapshot = runNative('roundtrip', encodeDeviceSyncPacket(snapshot))
    expect(parseDeviceSyncPacket(rustSnapshot, owner)).toEqual(snapshot)

    const rustPackets = [
      { v: 1, type: 'request', rosterAt: 42, page: { kind: 'metadata', offset: 32 } },
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
  return { ...process.env, IRIS_CHAT_RS_CORE_DIR: nativeCore }
}

function requireReleasedNativeSource(): void {
  const revision = spawnSync('git', ['-C', nativeRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (revision.status !== 0 || revision.stdout.trim() !== NATIVE_SOURCE_SHA) {
    throw new Error(`device-sync interop requires iris-chat-rs ${NATIVE_SOURCE_SHA}`)
  }
  const sourceDiff = spawnSync('git', [
    '-C',
    nativeRepo,
    'diff',
    '--quiet',
    NATIVE_SOURCE_SHA,
    '--',
    'core/Cargo.toml',
    'core/src/core/device_sync.rs',
    'core/src/core/device_sync_tcp.rs',
    'core/src/core/device_sync',
    'core/src/core/device_sync_tcp',
  ])
  if (sourceDiff.status !== 0) {
    throw new Error(`device-sync interop requires clean native sources at ${NATIVE_SOURCE_SHA}`)
  }
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
