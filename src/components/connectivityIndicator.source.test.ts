import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const connectivityIndicatorSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'components', 'ConnectivityIndicator.svelte'),
  'utf8',
)
const settingsSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'components', 'SettingsView.svelte'),
  'utf8',
)

describe('header connectivity indicator source', () => {
  it('shows only an offline label by default when no relays are connected', () => {
    expect(settingsSource).toContain('Show connectivity in header')
    expect(connectivityIndicatorSource).toContain('let showConnectivity = $derived($relayStore.showConnectivity)')
    expect(connectivityIndicatorSource).toContain('let showOfflineOnly = $derived(!showConnectivity && connectedCount === 0)')
    expect(connectivityIndicatorSource).toContain('{#if showOfflineOnly}')
    expect(connectivityIndicatorSource).toContain('>\n    offline\n  </button>')
  })
})
