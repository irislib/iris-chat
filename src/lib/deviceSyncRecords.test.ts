import { finalizeEvent } from 'nostr-tools'
import { describe, expect, it } from 'vitest'
import fixtures from './fixtures/deviceSyncRecords.json'
import { reactionControl, compareControlHead, deviceSyncRecordId, deviceSyncRecordScope, deviceSyncRecordTime, verifiedProfileEvent, type DeviceSyncRecord } from './deviceSyncRecords'
import { encodeDeviceSyncPacket, parseDeviceSyncPacket } from './deviceSyncProtocol'

describe('shared private record contract', () => {
  it.each(fixtures)('matches the cross-platform $name identity',  (fixture: typeof fixtures[number]) => {
    const record = fixture.record as DeviceSyncRecord
    expect(deviceSyncRecordId(record)).toBe(fixture.id)
    expect(deviceSyncRecordTime(record)).toBe(fixture.timestamp)
    expect(deviceSyncRecordScope(record)).toBe(record.type === 'message' || record.type === 'reaction' || record.type === 'messageMutation' ? 'history' : 'state')
  })
  it('keeps group identity independent of order and local acceptance', () => {
    const record = fixtures.find(item => item.name === 'group')!.record as Extract<DeviceSyncRecord, { type: 'group' }>
    expect(deviceSyncRecordId({ ...record, group: { ...record.group, members: [...record.group.members].reverse(), accepted: false } })).toBe(deviceSyncRecordId(record))
  })
  it('round-trips negotiated records with the existing base64 message wire format', () => {
    const packet = { v: 1 as const, type: 'historyRecords' as const, session: 'a'.repeat(32),
      records: fixtures.map(fixture => fixture.record as DeviceSyncRecord), requested: [] }
    expect(parseDeviceSyncPacket(encodeDeviceSyncPacket(packet), '1'.repeat(64))).toEqual(packet)
    const wire = JSON.parse(new TextDecoder().decode(encodeDeviceSyncPacket(packet)))
    expect(wire.records[0].message.body).toBe('SGVsbG8=')
    const state = { v: 1 as const, type: 'historyOpen' as const, session: 'a'.repeat(32), scope: 'state' as const, since: 0, until: 0, frame: '00' }
    expect(parseDeviceSyncPacket(encodeDeviceSyncPacket(state), '1'.repeat(64))).toEqual(state)
    expect(() => parseDeviceSyncPacket(encodeDeviceSyncPacket({ ...state, until: 1 }), '1'.repeat(64))).toThrow('state window')
  })
  it('accepts plain and legacy JSON removal controls without inventing a target', () => {
    expect(reactionControl({ content: '', tags: [['e', 'target']] })).toEqual({ messageId: 'target', emoji: '' })
    expect(reactionControl({ content: '{"type":"reaction","messageId":"target","emoji":""}', tags: [['e', 'target']] })).toEqual({ messageId: 'target', emoji: '' })
    expect(reactionControl({ content: '{"type":"reaction","messageId":"other","emoji":"❤️"}', tags: [['e', 'target']] })).toBeUndefined()
  })
  it('shares UTF-8 profile and reaction limits with native', () => {
    const secret = new Uint8Array(32).fill(9)
    const profile = finalizeEvent({ kind: 0, created_at: 1, tags: [], content: JSON.stringify({ about: 'x'.repeat(20_000) }) }, secret)
    expect(verifiedProfileEvent(profile)?.id).toBe(profile.id)
    const tooManyTags = finalizeEvent({ kind: 0, created_at: 1, tags: Array.from({ length: 257 }, () => ['x']), content: '{}' }, secret)
    expect(verifiedProfileEvent(tooManyTags)).toBeUndefined()
    const large = finalizeEvent({ kind: 0, created_at: 1, tags: [], content: JSON.stringify({ about: '☕'.repeat(12_000) }) }, secret)
    expect(verifiedProfileEvent(large)).toBeUndefined()
    const message = fixtures[0].record as Extract<DeviceSyncRecord, { type: 'message' }>
    const packet = { v: 1 as const, type: 'historyRecords' as const, session: 'a'.repeat(32), records: [{ ...message, message: { ...message.message, legacyReactions: [{ author: 'a'.repeat(64), emoji: 'x'.repeat(100) }] } }], requested: [] }
    expect(parseDeviceSyncPacket(encodeDeviceSyncPacket(packet), 'a'.repeat(64))).toEqual(packet)
  })
  it('orders same-second add/remove controls deterministically', () => {
    expect(compareControlHead({ createdAt: 1, createdAtMs: 1002, id: 'a' }, { createdAt: 1, createdAtMs: 1001, id: 'z' })).toBeGreaterThan(0)
    expect(compareControlHead({ createdAt: 1, id: 'b' }, { createdAt: 1, id: 'a' })).toBeGreaterThan(0)
  })
  it('verifies original profile signatures even after a previously verified object changes', () => {
    const profile = fixtures.find(item => item.name === 'profile')!.record as Extract<DeviceSyncRecord, { type: 'profile' }>
    const valid = verifiedProfileEvent(profile.event)!
    expect(valid).toBeDefined()
    expect(verifiedProfileEvent({ ...valid, content: '{"name":"forged"}' })).toBeUndefined()
    expect(verifiedProfileEvent({ ...valid, kind: 1 })).toBeUndefined()
  })
})
