export const NATIVE_APP_DOWNLOAD_URL = 'https://irischat.org/#downloads'
export const NATIVE_APP_SUGGESTION_KEY = 'iris-native-app-suggestion'
const releaseRootUrl = 'https://cdn.iris.to/npub1399g0q2gtwjcglyjcg3jw3rcllqhm375pwases5hkvqa56aqe5wsz2eaap/releases%2Firis-chat-rs'
export const NATIVE_APP_RELEASE_BASE_URL = `${releaseRootUrl}/latest`
export const NATIVE_APP_RELEASE_MANIFEST_URL = `${NATIVE_APP_RELEASE_BASE_URL}/release.json`
export const NATIVE_APP_STORE_URL = 'https://apps.apple.com/app/iris-chat/id6785411684'

export type NativeAppPlatform = 'iPhone' | 'iPad' | 'Android' | 'Mac' | 'Windows' | 'Linux'
export type NativeAppDownload = { href: string; detail?: string }

type ReleaseDownloadPlatform = Exclude<NativeAppPlatform, 'iPhone' | 'iPad'>
const releaseTargets: Record<ReleaseDownloadPlatform, {
  platform: string; architecture: string; kind: string; suffix: string; detail?: string
}> = {
  Mac: { platform: 'macos', architecture: 'arm64', kind: 'archive', suffix: '-macos-arm64.dmg', detail: 'Apple silicon' },
  Windows: { platform: 'windows', architecture: 'x64', kind: 'nsis', suffix: '-windows-x64-setup.exe' },
  Android: { platform: 'android', architecture: 'arm64', kind: 'archive', suffix: '-android-arm64.apk' },
  Linux: { platform: 'linux', architecture: 'x64', kind: 'archive', suffix: '-linux-x64.tar.gz' },
}

export async function loadNativeAppDownload(platform: NativeAppPlatform, signal?: AbortSignal): Promise<NativeAppDownload> {
  const fallback = { href: NATIVE_APP_DOWNLOAD_URL }
  if (signal?.aborted) return fallback
  if (platform === 'iPhone' || platform === 'iPad') return { href: NATIVE_APP_STORE_URL }
  const target = releaseTargets[platform]
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 5000)
  try {
    // Consume the same release metadata as irischat.org; never send the chat URL.
    const response = await fetch(NATIVE_APP_RELEASE_MANIFEST_URL, {
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: controller.signal,
    })
    if (!response.ok || controller.signal.aborted) return fallback
    const manifest: unknown = await response.json()
    if (controller.signal.aborted || !manifest || typeof manifest !== 'object' ||
        !('tag' in manifest) || typeof manifest.tag !== 'string' || !/^v[0-9]/.test(manifest.tag) || /[^A-Za-z0-9.-]/.test(manifest.tag) ||
        !('assets' in manifest) || !Array.isArray(manifest.assets)) return fallback
    for (const asset of manifest.assets) {
      if (!asset || typeof asset !== 'object' || asset.platform !== target.platform ||
          asset.architecture !== target.architecture || asset.kind !== target.kind || typeof asset.name !== 'string') continue
      // Published GUI files live directly in assets/. Exact basename matching
      // excludes paths, encoded separators, URLs, query strings, and fragments.
      if (asset.name !== `iris-chat-${manifest.tag}${target.suffix}` ||
          asset.path !== `assets/${asset.name}`) continue
      // Pin the selected file so a newer release cannot change it before click.
      return { href: `${releaseRootUrl}/${manifest.tag}/${asset.path}`, ...(target.detail ? { detail: target.detail } : {}) }
    }
    return fallback
  } catch {
    return fallback
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

// The caller validates the chat/invite first. Keep its encoded fragment local
// to the browser/native handoff, never append it to the downloads page.
export function nativeAppChatHref(webURL: string): string {
  const url = new URL(webURL)
  return `irischat://chat.iris.to${url.pathname}${url.hash}`
}

export function nativeAppPlatform(userAgent: string, maxTouchPoints = 0): NativeAppPlatform | null {
  if (/iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return 'iPad'
  if (/iPhone|iPod/i.test(userAgent)) return 'iPhone'
  if (/Android/i.test(userAgent)) return 'Android'
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'Mac'
  if (/Windows NT/i.test(userAgent)) return 'Windows'
  // ChromeOS and mobile Linux browsers do not use the desktop Linux build.
  if (/Linux/i.test(userAgent) && !/CrOS|Mobile/i.test(userAgent)) return 'Linux'
  return null
}
