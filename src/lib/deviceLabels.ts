import { nip19 } from 'nostr-tools'

export interface DeviceLabels {
  deviceLabel?: string
  clientLabel?: string
  updatedAt?: number
}

export interface RegisteredDeviceDisplay {
  title: string
  subtitle?: string
}

export interface BrowserVersionBrand {
  brand: string
  version: string
}

export interface BrowserDeviceHints {
  brands?: BrowserVersionBrand[]
  fullVersionList?: BrowserVersionBrand[]
  platform?: string
  platformVersion?: string
  model?: string
  mobile?: boolean
}

interface BrowserInfo {
  name: string
  version?: string
}

interface PlatformInfo {
  device?: string
  os?: {
    name: string
    version?: string
  }
}

const normalizeLabel = (value?: string | null): string | undefined => {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

export function formatDeviceIdentifier(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey)
  } catch {
    return pubkey.trim() || 'Unknown device'
  }
}

const cleanLabelPart = (value?: string | null): string | undefined => {
  const normalized = value?.replace(/\s+/g, ' ').trim()
  return normalized || undefined
}

const normalizeVersion = (value?: string | null): string | undefined => {
  const normalized = cleanLabelPart(value?.replace(/_/g, '.'))
  if (!normalized) return undefined
  const parts = normalized.split('.')
  while (parts.length > 1 && parts[parts.length - 1] === '0') {
    parts.pop()
  }
  return parts.join('.')
}

const formatBrowserVersion = (name: string, version?: string): string | undefined => {
  const normalized = normalizeVersion(version)
  if (!normalized) return undefined
  const parts = normalized.split('.').filter(Boolean)
  if (name === 'Safari' && parts.length >= 2) {
    return parts.slice(0, 2).join('.')
  }
  return parts[0] || normalized
}

const withVersion = (
  name: string,
  version: string | undefined,
  formatter: (name: string, version?: string) => string | undefined = (_name, value) =>
    normalizeVersion(value)
): string => {
  const formatted = formatter(name, version)
  return formatted ? `${name} ${formatted}` : name
}

const browserInfoFromBrands = (
  brands: BrowserVersionBrand[] | undefined
): BrowserInfo | undefined => {
  if (!brands?.length) return undefined

  const candidates: Array<[RegExp, string]> = [
    [/microsoft edge|edge/i, 'Edge'],
    [/google chrome|chrome/i, 'Chrome'],
    [/opera|opr/i, 'Opera'],
    [/firefox/i, 'Firefox'],
    [/safari/i, 'Safari'],
    [/chromium/i, 'Chromium'],
  ]

  for (const [pattern, name] of candidates) {
    const match = brands.find((brand) => pattern.test(brand.brand))
    if (match) return { name, version: match.version }
  }

  return undefined
}

const browserInfoFromHints = (hints?: BrowserDeviceHints): BrowserInfo | undefined => {
  return browserInfoFromBrands(hints?.fullVersionList) || browserInfoFromBrands(hints?.brands)
}

const browserInfoFromUserAgent = (userAgent: string): BrowserInfo | undefined => {
  const edge = userAgent.match(/(?:Edg|EdgiOS|EdgA)\/([\d.]+)/i)
  if (edge) return { name: 'Edge', version: edge[1] }

  const firefox = userAgent.match(/(?:Firefox|FxiOS)\/([\d.]+)/i)
  if (firefox) return { name: 'Firefox', version: firefox[1] }

  const opera = userAgent.match(/(?:OPR|OPiOS|Opera)\/([\d.]+)/i)
  if (opera) return { name: 'Opera', version: opera[1] }

  const chrome = userAgent.match(/(?:Chrome|CriOS)\/([\d.]+)/i)
  if (chrome) return { name: 'Chrome', version: chrome[1] }

  const safari = userAgent.match(/Version\/([\d.]+).*Safari/i)
  if (safari) return { name: 'Safari', version: safari[1] }

  return undefined
}

const windowsVersionFromPlatformVersion = (version?: string): string | undefined => {
  const normalized = normalizeVersion(version)
  const major = Number(normalized?.split('.')[0])
  if (!Number.isFinite(major) || major <= 0) return undefined
  return major >= 13 ? '11' : '10'
}

const platformInfoFromHints = (hints?: BrowserDeviceHints): PlatformInfo | undefined => {
  const platform = cleanLabelPart(hints?.platform)
  const model = cleanLabelPart(hints?.model)
  if (!platform && !model) return undefined

  const lowerPlatform = platform?.toLowerCase()
  if (lowerPlatform === 'windows') {
    return {
      os: {
        name: 'Windows',
        version: windowsVersionFromPlatformVersion(hints?.platformVersion),
      },
    }
  }
  if (lowerPlatform === 'macos') {
    return {
      device: 'Mac',
      os: { name: 'macOS', version: normalizeVersion(hints?.platformVersion) },
    }
  }
  if (lowerPlatform === 'android') {
    return {
      device: model,
      os: { name: 'Android', version: normalizeVersion(hints?.platformVersion) },
    }
  }
  if (lowerPlatform === 'ios') {
    return {
      device: model || (hints?.mobile ? 'iPhone' : undefined),
      os: { name: 'iOS', version: normalizeVersion(hints?.platformVersion) },
    }
  }
  if (lowerPlatform === 'chrome os') {
    return {
      os: { name: 'ChromeOS', version: normalizeVersion(hints?.platformVersion) },
    }
  }
  if (lowerPlatform === 'linux') {
    return { os: { name: 'Linux' } }
  }

  return {
    device: model,
    os: platform ? { name: platform, version: normalizeVersion(hints?.platformVersion) } : undefined,
  }
}

const platformInfoFromUserAgent = (userAgent: string): PlatformInfo | undefined => {
  const ios = userAgent.match(/\b(iPhone|iPad|iPod)\b.*?\bOS ([\d_]+)/i)
  if (ios) {
    return {
      device: ios[1] === 'iPod' ? 'iPod touch' : ios[1],
      os: { name: 'iOS', version: normalizeVersion(ios[2]) },
    }
  }

  const android = userAgent.match(/Android ([\d.]+)/i)
  if (android) {
    return { os: { name: 'Android', version: normalizeVersion(android[1]) } }
  }

  const mac = userAgent.match(/Mac OS X ([\d_]+)/i)
  if (/macintosh|mac os x/i.test(userAgent)) {
    return {
      device: 'Mac',
      os: { name: 'macOS', version: normalizeVersion(mac?.[1]) },
    }
  }

  if (/windows/i.test(userAgent)) return { os: { name: 'Windows' } }
  if (/linux/i.test(userAgent)) return { os: { name: 'Linux' } }
  return undefined
}

const isStandaloneApp = (): boolean => {
  if (typeof window === 'undefined') return false

  const standaloneMedia = window.matchMedia?.('(display-mode: standalone)').matches
  const navigatorStandalone = Boolean(
    (window.navigator as Navigator & { standalone?: boolean }).standalone
  )

  return standaloneMedia || navigatorStandalone
}

export const inferBrowserDeviceLabel = (
  userAgent: string,
  hints?: BrowserDeviceHints
): string => {
  const browser = browserInfoFromHints(hints) || browserInfoFromUserAgent(userAgent)
  const platform = platformInfoFromHints(hints) || platformInfoFromUserAgent(userAgent)
  const parts = [
    browser ? withVersion(browser.name, browser.version, formatBrowserVersion) : undefined,
    platform?.device,
    platform?.os ? withVersion(platform.os.name, platform.os.version) : undefined,
  ].filter((part): part is string => !!part)

  const uniqueParts = parts.filter(
    (part, index) =>
      parts.findIndex((candidate) => candidate.toLowerCase() === part.toLowerCase()) === index
  )

  if (uniqueParts.length > 0) {
    return uniqueParts.join(' - ')
  }

  return 'Browser'
}

const currentClientLabel = (): string => {
  return isStandaloneApp() ? 'Iris Chat App' : 'Iris Chat Web'
}

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: BrowserDeviceHints & {
    getHighEntropyValues?: (hints: string[]) => Promise<BrowserDeviceHints>
  }
}

const getCurrentBrowserDeviceHints = async (): Promise<BrowserDeviceHints | undefined> => {
  if (typeof navigator === 'undefined') return undefined
  const userAgentData = (navigator as NavigatorWithUserAgentData).userAgentData
  if (!userAgentData) return undefined

  const lowEntropyHints: BrowserDeviceHints = {
    brands: userAgentData.brands,
    platform: userAgentData.platform,
    mobile: userAgentData.mobile,
  }
  if (!userAgentData.getHighEntropyValues) return lowEntropyHints

  try {
    return {
      ...lowEntropyHints,
      ...(await userAgentData.getHighEntropyValues([
        'architecture',
        'bitness',
        'fullVersionList',
        'model',
        'platform',
        'platformVersion',
      ])),
    }
  } catch {
    return lowEntropyHints
  }
}

export const getCurrentDeviceRegistrationLabels = async (): Promise<DeviceLabels> => {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const hints = await getCurrentBrowserDeviceHints()
  return {
    deviceLabel: inferBrowserDeviceLabel(userAgent, hints),
    clientLabel: currentClientLabel(),
  }
}

export const getLinkedDeviceRegistrationLabels = async (): Promise<DeviceLabels> => {
  return {
    deviceLabel: 'Linked device',
    clientLabel: 'Iris Chat',
  }
}

export const describeRegisteredDevice = (
  identityPubkey: string,
  labels?: DeviceLabels
): RegisteredDeviceDisplay => {
  const fallback = formatDeviceIdentifier(identityPubkey)
  const deviceLabel = normalizeLabel(labels?.deviceLabel)
  const clientLabel = normalizeLabel(labels?.clientLabel)

  if (deviceLabel) {
    return {
      title: deviceLabel,
      subtitle: clientLabel,
    }
  }

  if (clientLabel) {
    return {
      title: clientLabel,
      subtitle: fallback,
    }
  }

  return { title: fallback }
}

export const describeDeviceRosterDevice = (
  identityPubkey: string,
  labels: DeviceLabels | undefined,
  isCurrentDevice: boolean
): RegisteredDeviceDisplay => {
  const fallback = formatDeviceIdentifier(identityPubkey)
  const deviceLabel = normalizeLabel(labels?.deviceLabel)
  const clientLabel = normalizeLabel(labels?.clientLabel)

  if (isCurrentDevice) {
    return {
      title: 'This device',
      subtitle: [deviceLabel, clientLabel].filter(Boolean).join(' · ') || undefined,
    }
  }

  if (deviceLabel) {
    return {
      title: deviceLabel,
      subtitle: clientLabel,
    }
  }

  if (clientLabel) {
    return {
      title: 'Linked device',
      subtitle: clientLabel,
    }
  }

  return {
    title: 'Linked device',
    subtitle: fallback,
  }
}
