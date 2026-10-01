import { describe, expect, it, vi } from 'vitest'
import { blockOtherWebSockets, forbiddenWebSocketOrigins } from '../../e2e/fixtures/webSocketIsolation'

describe('call fixture WebSocket isolation', () => {
  const allowed = ['ws://127.0.0.1:43123/fips', 'ws://localhost:43124/relay']
  // Playwright serializes RegExp source/flags to the browser-side dispatcher.
  const pattern = forbiddenWebSocketOrigins(allowed)
  const blocked = new RegExp(pattern.source, pattern.flags)

  it('leaves exact allowed origins unhandled, including other paths and queries', () => {
    for (const url of [
      ...allowed, 'ws://127.0.0.1:43123', 'ws://127.0.0.1:43123/other?next=wss://outside.test',
      'ws://localhost:43124/?subscription=1',
    ]) expect(blocked.test(new URL(url).href), url).toBe(false)
  })

  it('blocks other ports, nonlocal sockets, and hostname or authority lookalikes', () => {
    for (const url of [
      'ws://127.0.0.1:43125/fips', 'ws://127.0.0.1/fips', 'ws://localhost:43123/fips',
      'ws://outside.test/fips', 'ws://localhost.evil.test:43124/relay',
      'ws://127x0x0x1:43123/fips', 'ws://127.0.0.1:43123@outside.test/fips',
    ]) expect(blocked.test(new URL(url).href), url).toBe(true)
  })

  it('requires ws and wss origins to be allowed separately', () => {
    expect(blocked.test('wss://127.0.0.1:43123/fips')).toBe(true)
    const secure = forbiddenWebSocketOrigins(['wss://seed.test:8443/fips'])
    expect(secure.test('wss://seed.test:8443/other?x=1')).toBe(false)
    expect(secure.test('ws://seed.test:8443/fips')).toBe(true)
    expect(secure.test('wss://seed.test/fips')).toBe(true)
  })

  it('normalizes default ports while escaping regex characters in origins', () => {
    const escaped = forbiddenWebSocketOrigins(['wss://seed+one.test:443/fips', 'ws://[::1]:43123/fips'])
    expect(escaped.test(new URL('wss://seed+one.test/other').href)).toBe(false)
    expect(escaped.test(new URL('ws://[::1]:43123/other').href)).toBe(false)
    expect(escaped.test('wss://seedddoneXtest/fips')).toBe(true)
    expect(escaped.test('ws://[::1]:43124/fips')).toBe(true)
  })

  it('blocks every socket with an empty allowlist and rejects non-WebSocket configuration', () => {
    expect(forbiddenWebSocketOrigins([]).test(allowed[0])).toBe(true)
    expect(() => forbiddenWebSocketOrigins(['https://localhost:43123'])).toThrow('Expected a WebSocket URL')
  })

  it('registers only a serializable blocking pattern and closes matched sockets', async () => {
    const routeWebSocket = vi.fn<Parameters<typeof blockOtherWebSockets>[0]['routeWebSocket']>().mockResolvedValue(undefined)
    await blockOtherWebSockets({ routeWebSocket }, allowed)
    expect(routeWebSocket).toHaveBeenCalledTimes(1)
    const [matcher, handler] = routeWebSocket.mock.calls[0]
    expect(matcher).toBeInstanceOf(RegExp)
    expect((matcher as RegExp).test(allowed[0])).toBe(false)
    const close = vi.fn().mockResolvedValue(undefined)
    const connectToServer = vi.fn()
    await handler({ close, connectToServer } as unknown as Parameters<typeof handler>[0])
    expect(close).toHaveBeenCalledTimes(1)
    expect(connectToServer).not.toHaveBeenCalled()
  })
})
