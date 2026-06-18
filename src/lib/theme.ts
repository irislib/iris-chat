import { writable } from 'svelte/store'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'iris-chat-theme'
const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: '#f7f7f8',
  dark: '#000000',
}

const isThemePreference = (value: string | null): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark'

const getSystemTheme = (): ResolvedTheme => {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

const resolveTheme = (preference: ThemePreference): ResolvedTheme =>
  preference === 'system' ? getSystemTheme() : preference

const readStoredPreference = (): ThemePreference => {
  if (typeof localStorage === 'undefined') return 'system'
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

const applyTheme = (preference: ThemePreference): void => {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(preference)
  document.documentElement.dataset.themePreference = preference
  document.documentElement.dataset.theme = resolved

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  themeColor?.setAttribute('content', THEME_COLOR[resolved])
}

const initialPreference = readStoredPreference()

export const themePreference = writable<ThemePreference>(initialPreference)

export const setThemePreference = (preference: ThemePreference): void => {
  try {
    if (preference === 'system') {
      localStorage.removeItem(THEME_STORAGE_KEY)
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, preference)
    }
  } catch {
    // Ignore persistence errors; the in-memory preference still applies.
  }
  themePreference.set(preference)
}

export const initTheme = (): (() => void) => {
  applyTheme(initialPreference)

  const unsubscribe = themePreference.subscribe(applyTheme)
  const media = window.matchMedia('(prefers-color-scheme: light)')
  const onSystemThemeChange = () => {
    if (readStoredPreference() === 'system') {
      applyTheme('system')
    }
  }
  media.addEventListener('change', onSystemThemeChange)

  return () => {
    unsubscribe()
    media.removeEventListener('change', onSystemThemeChange)
  }
}
