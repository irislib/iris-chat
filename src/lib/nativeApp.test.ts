import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeAppPlatform, nativeAppChatHref, loadNativeAppDownload, NATIVE_APP_DOWNLOAD_URL,
  NATIVE_APP_RELEASE_BASE_URL, NATIVE_APP_RELEASE_MANIFEST_URL, NATIVE_APP_STORE_URL, type NativeAppPlatform } from './nativeApp'

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

describe('native app direct downloads', () => {
  const tag = 'v2099.1.2.3'
  const asset = (platform: string, architecture: string, kind: string, suffix: string) => {
    const name = `iris-chat-${tag}-${suffix}`
    return { name, path: `assets/${name}`, platform, architecture, kind, size: 1234, sha256: 'a'.repeat(64) }
  }
  const mac = asset('macos', 'arm64', 'archive', 'macos-arm64.dmg')
  const windows = asset('windows', 'x64', 'nsis', 'windows-x64-setup.exe')
  const android = asset('android', 'arm64', 'archive', 'android-arm64.apk')
  const linux = asset('linux', 'x64', 'archive', 'linux-x64.tar.gz')
  const respond = (manifest: unknown, ok = true) => {
    const fetch = vi.fn(async () => ({ ok, json: async () => manifest }))
    vi.stubGlobal('fetch', fetch)
    return fetch
  }
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it.each(['iPhone', 'iPad'] as const)('links %s to the App Store without requesting a manifest', async (platform: NativeAppPlatform) => {
    const fetch = respond(null)
    expect(await loadNativeAppDownload(platform)).toEqual({ href: NATIVE_APP_STORE_URL })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['Mac', mac, 'Apple silicon'], ['Windows', windows, undefined],
    ['Android', android, undefined], ['Linux', linux, undefined],
  ] as const)('selects the published %s GUI file from authoritative metadata', async (platform: NativeAppPlatform, expected: typeof mac, detail: string | undefined) => {
    const fetch = respond({ tag, assets: [
      asset('macos', 'arm64', 'app-bundle', 'macos-arm64.app.tar.gz'),
      asset('linux', 'x64', 'deb', 'linux-x64.deb'),
      { ...linux, name: 'iris-cli-v2099.1.2.3-linux-x64.tar.gz', path: 'assets/iris-cli-v2099.1.2.3-linux-x64.tar.gz' },
      mac, windows, android, linux,
    ] })
    expect(await loadNativeAppDownload(platform)).toEqual({ href: `${NATIVE_APP_RELEASE_BASE_URL.replace(/latest$/, tag)}/${expected.path}`, ...(detail ? { detail } : {}) })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(NATIVE_APP_RELEASE_MANIFEST_URL, expect.objectContaining({
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
    }))
  })

  it.each([
    null, {}, { tag, assets: null }, { tag, assets: {} }, { tag, assets: [] },
    { tag, assets: [null, 'not an asset', { ...mac, platform: 'ios' }] },
    { tag, assets: [{ ...mac, architecture: 'x64' }] },
    { tag, assets: [{ ...mac, kind: 'app-bundle' }] },
  ])('falls back when the manifest has no usable asset: %j', async (manifest: unknown) => {
    respond(manifest)
    expect(await loadNativeAppDownload('Mac')).toEqual({ href: NATIVE_APP_DOWNLOAD_URL })
  })

  it.each([undefined, null, 2026, '', '..', '../v2099.1.2.3', 'v2099/other',
    'v2099\\other', 'v2099%2fother', 'v2099?token=test', 'v2099#invite', 'v2099\n',
  ])('rejects a missing or unsafe release tag: %j', async (invalidTag: unknown) => {
    const name = `iris-chat-${invalidTag}-macos-arm64.dmg`
    respond({ tag: invalidTag, assets: [{ ...mac, name, path: `assets/${name}` }] })
    expect(await loadNativeAppDownload('Mac')).toEqual({ href: NATIVE_APP_DOWNLOAD_URL })
  })

  it('rejects an asset belonging to a different release', async () => {
    respond({ tag: 'v2099.1.2.4', assets: [mac] })
    expect(await loadNativeAppDownload('Mac')).toEqual({ href: NATIVE_APP_DOWNLOAD_URL })
  })

  it.each([
    '../file.dmg', `/assets/${mac.name}`, `https://other.example/${mac.name}`,
    `//other.example/${mac.name}`, `assets/../${mac.name}`, `assets/%2e%2e/${mac.name}`,
    `assets%2f${mac.name}`, `assets/${mac.name}?token=test`, `assets/${mac.name}#invite`,
    `assets\\${mac.name}`, `assets/${mac.name}%00`,
  ])('rejects unsafe manifest paths: %s', async (path: string) => {
    respond({ tag, assets: [{ ...mac, path }] })
    expect(await loadNativeAppDownload('Mac')).toEqual({ href: NATIVE_APP_DOWNLOAD_URL })
  })

  it.each(['iris-chat-v2099%2f-macos-arm64.dmg', 'iris-chat-v2099/other-macos-arm64.dmg', 'iris-cli-v2099-macos-arm64.dmg'])('rejects an unsafe or non-GUI basename: %s', async (name: string) => {
    respond({ tag, assets: [{ ...mac, name, path: `assets/${name}` }] })
    expect(await loadNativeAppDownload('Mac')).toEqual({ href: NATIVE_APP_DOWNLOAD_URL })
  })

  it('falls back on unavailable, invalid JSON, and failed requests', async () => {
    respond({ tag, assets: [mac] }, false)
    expect(await loadNativeAppDownload('Mac')).toEqual({ href: NATIVE_APP_DOWNLOAD_URL })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON') } })))
    expect(await loadNativeAppDownload('Mac')).toEqual({ href: NATIVE_APP_DOWNLOAD_URL })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network unavailable') }))
    expect(await loadNativeAppDownload('Mac')).toEqual({ href: NATIVE_APP_DOWNLOAD_URL })
  })

  it('does not request a manifest if already cancelled', async () => {
    const fetch = respond({ tag, assets: [mac] })
    const controller = new AbortController()
    controller.abort()
    expect(await loadNativeAppDownload('Mac', controller.signal)).toEqual({ href: NATIVE_APP_DOWNLOAD_URL })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['caller', 'timeout'])('cancels the request when %s aborts it', async (reason: string) => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      requestSignal = init.signal as AbortSignal
      requestSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })))
    const controller = new AbortController()
    const result = loadNativeAppDownload('Mac', controller.signal)
    if (reason === 'caller') controller.abort()
    else await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toEqual({ href: NATIVE_APP_DOWNLOAD_URL })
    expect(requestSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
