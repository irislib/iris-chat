export const SETTINGS_PAGES = [
  { id: 'profile', title: 'Profile', description: 'Name, picture and account', icon: 'i-carbon-user-avatar-filled', group: 'Account' },
  { id: 'devices', title: 'Devices', description: 'Link and manage devices', icon: 'i-carbon-devices', group: 'Account' },
  { id: 'appearance', title: 'Appearance', description: 'Theme', icon: 'i-carbon-paint-brush', group: 'Preferences' },
  { id: 'privacy', title: 'Privacy', description: 'Receipts, typing and message requests', icon: 'i-carbon-security', group: 'Preferences' },
  { id: 'calls', title: 'Calls', description: 'Voice, video and quality', icon: 'i-carbon-phone-filled', group: 'Preferences' },
  { id: 'notifications', title: 'Notifications', description: 'Message alerts', icon: 'i-carbon-notification-filled', group: 'Preferences' },
  { id: 'network', title: 'Message servers', description: 'Connections', icon: 'i-carbon-network-3', group: 'More' },
  { id: 'about', title: 'About', description: 'Iris Chat and downloads', icon: 'i-carbon-information-filled', group: 'More' },
] as const

export type SettingsPage = typeof SETTINGS_PAGES[number]['id']

export function settingsHref(page: SettingsPage | null = null): string {
  return page ? `#settings/${page}` : '#settings'
}

export function parseSettingsRoute(hash: string): { page: SettingsPage | null } | null {
  if (hash !== '#settings' && !hash.startsWith('#settings/')) return null
  const section = hash.slice('#settings/'.length)
  return { page: SETTINGS_PAGES.find(page => page.id === section)?.id ?? null }
}
