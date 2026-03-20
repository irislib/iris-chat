import {describe, expect, it} from 'vitest'

import {
  describeRegisteredDevice,
  getLinkedDeviceRegistrationLabels,
  inferBrowserDeviceLabel,
  truncateDevicePubkey,
} from './deviceLabels'

describe('deviceLabels', () => {
  it('prefers the encrypted device label and keeps client metadata in the subtitle', () => {
    const pubkey = '6b911f0f1ca34f7f6a9f2f7a7d8aa0c92e3f0f0d6bb64abd0c4f2e55d8f67f1f'

    const display = describeRegisteredDevice(pubkey, {
      deviceLabel: 'Sirius MacBook',
      clientLabel: 'Iris Chat Web',
    })

    expect(display.title).toBe('Sirius MacBook')
    expect(display.subtitle).toBe(`Iris Chat Web • ${truncateDevicePubkey(pubkey)}`)
  })

  it('falls back to the client label when no device label is available', () => {
    const pubkey = '1f1e1d1c1b1a19181716151413121110ffeeddccbbaa99887766554433221100'

    const display = describeRegisteredDevice(pubkey, {
      clientLabel: 'Iris Chat Web',
    })

    expect(display.title).toBe('Iris Chat Web')
    expect(display.subtitle).toBe(truncateDevicePubkey(pubkey))
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
