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

const platformLabelFromUserAgent = (userAgent: string): string | undefined => {
  if (/iphone/i.test(userAgent)) return 'iPhone'
  if (/ipad/i.test(userAgent)) return 'iPad'
  if (/android/i.test(userAgent)) return 'Android'
  if (/macintosh|mac os x/i.test(userAgent)) return 'Mac'
  if (/windows/i.test(userAgent)) return 'Windows'
  if (/linux/i.test(userAgent)) return 'Linux'
  return undefined
}

const browserLabelFromUserAgent = (userAgent: string): string | undefined => {
  if (/edg\//i.test(userAgent)) return 'Edge'
  if (/firefox|fxios/i.test(userAgent)) return 'Firefox'
  if (/opr\/|opera/i.test(userAgent)) return 'Opera'
  if (/chrome|crios/i.test(userAgent)) return 'Chrome'
  if (/safari/i.test(userAgent)) return 'Safari'
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

export const inferBrowserDeviceLabel = (userAgent: string): string => {
  const browser = browserLabelFromUserAgent(userAgent)
  const platform = platformLabelFromUserAgent(userAgent)

  if (browser && platform) {
    return `${browser} on ${platform}`
  }

  return browser || platform || 'Browser'
}

const currentClientLabel = (): string => {
  return isStandaloneApp() ? 'Iris Chat App' : 'Iris Chat Web'
}

export const getCurrentDeviceRegistrationLabels = async (): Promise<DeviceLabels> => {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return {
    deviceLabel: inferBrowserDeviceLabel(userAgent),
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
