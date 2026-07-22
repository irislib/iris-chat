import { describe, it, expect } from 'vitest'
import { parseChatSettingsContent } from './chatSettings'

describe('parseChatSettingsContent', () => {
  it('parses a valid chat-settings payload with TTL', () => {
    const payload = JSON.stringify({
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: 3600,
    })
    const result = parseChatSettingsContent(payload)
    expect(result).toEqual({
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: 3600,
    })
  })

  it('parses null TTL (disabling disappearing messages)', () => {
    const payload = JSON.stringify({
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: null,
    })
    const result = parseChatSettingsContent(payload)
    expect(result).toEqual({
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: null,
    })
  })

  it('floors non-integer TTL values', () => {
    const payload = JSON.stringify({
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: 3600.7,
    })
    const result = parseChatSettingsContent(payload)
    expect(result).toEqual({
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: 3600,
    })
  })

  it('normalizes zero TTL to null', () => {
    const payload = JSON.stringify({
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: 0,
    })
    const result = parseChatSettingsContent(payload)
    expect(result).toEqual({
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: null,
    })
  })

  it('normalizes negative TTL to null', () => {
    const payload = JSON.stringify({
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: -100,
    })
    const result = parseChatSettingsContent(payload)
    expect(result).toEqual({
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: null,
    })
  })

  it('returns null for empty string', () => {
    expect(parseChatSettingsContent('')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseChatSettingsContent('not json')).toBeNull()
  })

  it('returns null for wrong type field', () => {
    const payload = JSON.stringify({
      type: 'other-settings',
      v: 1,
      messageTtlSeconds: 3600,
    })
    expect(parseChatSettingsContent(payload)).toBeNull()
  })

  it('returns null for wrong version', () => {
    const payload = JSON.stringify({
      type: 'chat-settings',
      v: 2,
      messageTtlSeconds: 3600,
    })
    expect(parseChatSettingsContent(payload)).toBeNull()
  })

  it('returns null for missing type field', () => {
    const payload = JSON.stringify({
      v: 1,
      messageTtlSeconds: 3600,
    })
    expect(parseChatSettingsContent(payload)).toBeNull()
  })

  it('returns null for non-object JSON', () => {
    expect(parseChatSettingsContent('"hello"')).toBeNull()
    expect(parseChatSettingsContent('42')).toBeNull()
    expect(parseChatSettingsContent('true')).toBeNull()
  })

  it('returns null for missing messageTtlSeconds', () => {
    const payload = JSON.stringify({
      type: 'chat-settings',
      v: 1,
    })
    expect(parseChatSettingsContent(payload)).toBeNull()
  })

  it('returns null for non-numeric messageTtlSeconds', () => {
    const payload = JSON.stringify({
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: 'forever',
    })
    expect(parseChatSettingsContent(payload)).toBeNull()
  })

  it('returns null for Infinity messageTtlSeconds', () => {
    expect(parseChatSettingsContent(
      '{"type":"chat-settings","v":1,"messageTtlSeconds":1e400}'
    )).toBeNull()
  })
})
