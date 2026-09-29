import { describe, expect, it } from 'vitest'
import { SETTINGS_PAGES, parseSettingsRoute, settingsHref } from './settingsNavigation'

describe('settings links', () => {
  it('keeps the existing menu URL and gives each page a refreshable link', () => {
    expect(settingsHref()).toBe('#settings')
    expect(parseSettingsRoute('#settings')).toEqual({ page: null })
    for (const page of SETTINGS_PAGES) {
      expect(parseSettingsRoute(settingsHref(page.id))).toEqual({ page: page.id })
    }
  })

  it('opens the menu for an unknown settings page', () => {
    for (const hash of ['#settings/', '#settings/unknown', '#settings/profile/extra']) {
      expect(parseSettingsRoute(hash)).toEqual({ page: null })
    }
  })

  it('does not consume chat, invite, profile or other hashes', () => {
    for (const hash of ['', '#/npub1test', '#/invite/secret', '#profile-test', '#settings-other']) {
      expect(parseSettingsRoute(hash)).toBeNull()
    }
  })
})
