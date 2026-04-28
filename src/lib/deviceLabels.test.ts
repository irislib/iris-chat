import {describe, expect, it} from 'vitest'

import {
  describeRegisteredDevice,
  getLinkedDeviceRegistrationLabels,
  inferBrowserDeviceLabel,
} from './deviceLabels'

describe('deviceLabels', () => {
  it('prefers the encrypted device label without exposing a hex identifier', () => {
    const pubkey = '6b911f0f1ca34f7f6a9f2f7a7d8aa0c92e3f0f0d6bb64abd0c4f2e55d8f67f1f'

    const display = describeRegisteredDevice(pubkey, {
      deviceLabel: 'Sirius MacBook',
      clientLabel: 'Iris Chat Web',
    })

    expect(display.title).toBe('Sirius MacBook')
    expect(display.subtitle).toBe('Iris Chat Web')
    expect(`${display.title} ${display.subtitle}`).not.toContain(pubkey.slice(0, 8))
  })

  it('falls back to an npub identifier instead of truncated hex', () => {
    const pubkey = '1f1e1d1c1b1a19181716151413121110ffeeddccbbaa99887766554433221100'

    const display = describeRegisteredDevice(pubkey)

    expect(display.title).toMatch(/^npub1/)
    expect(display.title).not.toContain(pubkey.slice(0, 8))
  })

  it('keeps client-only labels and uses npub as the identifier', () => {
    const pubkey = '2f1e1d1c1b1a19181716151413121110ffeeddccbbaa99887766554433221100'

    const display = describeRegisteredDevice(pubkey, {
      clientLabel: 'Iris Chat Web',
    })

    expect(display.title).toBe('Iris Chat Web')
    expect(display.subtitle).toMatch(/^npub1/)
    expect(display.subtitle).not.toContain(pubkey.slice(0, 8))
  })

  it('derives a browser-style label from the user agent', () => {
    expect(
      inferBrowserDeviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1'
      )
    ).toBe('Safari on iPhone')
  })

  it('uses a generic label for linked devices', async () => {
    await expect(getLinkedDeviceRegistrationLabels()).resolves.toEqual({
      deviceLabel: 'Linked device',
      clientLabel: 'Iris Chat',
    })
  })
})
