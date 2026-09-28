export const NATIVE_APP_DOWNLOAD_URL = 'https://irischat.org/#downloads'
export const NATIVE_APP_SUGGESTION_KEY = 'iris-native-app-suggestion'

export type NativeAppPlatform = 'iPhone' | 'iPad' | 'Android' | 'Mac' | 'Windows' | 'Linux'

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
