import { describe, expect, it } from 'vitest'
import {
  DEVICE_SYNC_MAX_PACKET_BYTES,
  DEVICE_SYNC_PAGE_MESSAGES,
  DEVICE_SYNC_PAGE_PACKETS,
  DEVICE_SYNC_PORT,
  DeviceSyncProtocolError,
  encodeDeviceSyncPacket,
  parseDeviceSyncPacket,
  type DeviceSyncPacket,
  type DeviceSyncSnapshot,
} from './deviceSyncProtocol'

const owner = 'a'.repeat(64)
const peer = 'b'.repeat(64)

const packets: DeviceSyncPacket[] = [
  { v: 1, type: 'request', rosterAt: 42 },
  {
    v: 1,
    type: 'request',
    rosterAt: 42,
    page: { kind: 'metadata', offset: 32 },
  },
  {
    v: 1,
    type: 'request',
    rosterAt: 42,
    page: {
      kind: 'messages',
      after: { createdAt: 44, chatId: peer, id: 'message-1' },
    },
  },
  { v: 1, type: 'resyncRequired' },
  {
    v: 1,
    type: 'pageEnd',
    rosterAt: 42,
    next: { kind: 'messages', after: null },
  },
  {
    v: 1,
    type: 'snapshot',
    rosterAt: 42,
    chats: [],
    appKeys: [],
    groups: [],
    messages: [{
      chatId: peer,
      id: 'message-1',
      body: 'Hello, linked device 👋',
      author: owner,
      createdAt: 43,
    }],
  },
]

describe('native device-sync protocol', () => {
  it('locks the native 0.1.39 service and page bounds', () => {
    expect(DEVICE_SYNC_PORT).toBe(7369)
    expect(DEVICE_SYNC_MAX_PACKET_BYTES).toBe(64 * 1024)
    expect(DEVICE_SYNC_PAGE_MESSAGES).toBe(32)
    expect(DEVICE_SYNC_PAGE_PACKETS).toBe(32)
  })

  it.each(packets)('round-trips $type packets', (packet: DeviceSyncPacket) => {
    expect(parseDeviceSyncPacket(encodeDeviceSyncPacket(packet), owner)).toEqual(packet)
  })

  it('uses the native base64 representation for message bodies', () => {
    const packet = packets.at(-1) as DeviceSyncSnapshot
    const wire = JSON.parse(new TextDecoder().decode(encodeDeviceSyncPacket(packet)))
    expect(wire.messages[0].body).toBe('SGVsbG8sIGxpbmtlZCBkZXZpY2Ug8J+Riw==')
  })

  it('treats a native null request page as the initial page', () => {
    const payload = new TextEncoder().encode('{"v":1,"type":"request","rosterAt":42,"page":null}')
    expect(parseDeviceSyncPacket(payload, owner)).toEqual({
      v: 1,
      type: 'request',
      rosterAt: 42,
    })
  })

  it('accepts an exact 64 KiB record and rejects one byte more', () => {
    const request = JSON.stringify({ v: 1, type: 'request', rosterAt: 42 })
    const exact = new TextEncoder().encode(request.padEnd(DEVICE_SYNC_MAX_PACKET_BYTES, ' '))
    expect(parseDeviceSyncPacket(exact, owner)).toEqual({ v: 1, type: 'request', rosterAt: 42 })
    expect(() => parseDeviceSyncPacket(
      new TextEncoder().encode(`${request}${' '.repeat(DEVICE_SYNC_MAX_PACKET_BYTES + 1 - request.length)}`),
      owner,
    )).toThrow(DeviceSyncProtocolError)
  })

  it.each([
    new Uint8Array([0xc3, 0x28]),
    new TextEncoder().encode('{"v":1,"type":"snapshot"'),
    new TextEncoder().encode('{"v":2,"type":"resyncRequired"}'),
    new TextEncoder().encode('{"v":1,"type":"unknown"}'),
    new TextEncoder().encode('{"v":1,"type":"request","rosterAt":1,"page":{"kind":"metadata","offset":-1}}'),
    new TextEncoder().encode(`{"v":1,"type":"snapshot","rosterAt":1,"messages":[{"chatId":"${peer}","id":"m","body":"%%%","author":"${owner}","createdAt":2}]}`),
  ])('rejects malformed protocol records without a fallback snapshot', (payload: Uint8Array) => {
    expect(() => parseDeviceSyncPacket(payload, owner)).toThrow(DeviceSyncProtocolError)
  })
})
