import { describe, expect, it } from 'vitest'
import { nativeAppPlatform, nativeAppChatHref, NATIVE_APP_DOWNLOAD_URL } from './nativeApp'

describe('native app suggestion', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', 5, 'iPhone'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1', 5, 'iPad'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1', 5, 'iPad'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130.0 Mobile Safari/537.36', 5, 'Android'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0', 0, 'Mac'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', 10, 'Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0', 0, 'Linux'],
    ['Mozilla/5.0 (X11; CrOS x86_64 130.0) Chrome/130.0', 0, null],
    ['Mozilla/5.0 (Mobile; Linux) Firefox/130.0', 5, null],
    ['Unknown browser', 0, null],
  ])('offers the matching app for %s', (userAgent: string, touches: number, platform: string | null) => {
    expect(nativeAppPlatform(userAgent, touches)).toBe(platform)
  })

  it('uses the canonical downloads page without device or invite metadata', () => {
    expect(NATIVE_APP_DOWNLOAD_URL).toBe('https://irischat.org/#downloads')
  })

  it('preserves the exact encoded invite fragment only in the native handoff', () => {
    const fragment = '#/invite/%7B%22sharedSecret%22%3A%22local%2520secret%22%7D'
    expect(nativeAppChatHref(`https://chat.iris.to/${fragment}`)).toBe(`irischat://chat.iris.to/${fragment}`)
    expect(nativeAppChatHref(`http://127.0.0.1:4173/${fragment}`)).toBe(`irischat://chat.iris.to/${fragment}`)
    expect(NATIVE_APP_DOWNLOAD_URL).not.toContain('sharedSecret')
  })
})
