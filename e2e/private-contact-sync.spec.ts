import { test, expect, useTestRelay } from './fixtures'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { mkdir } from 'node:fs/promises'

test('private details sync across devices, retain offline clears, and stay account scoped', async ({ browser, testRelay, testRelayUrl, baseURL }) => {
  test.setTimeout(120_000)
  const secret = generateSecretKey(), account = getPublicKey(secret), person = getPublicKey(generateSecretKey())
  const contexts = []
  async function device(key: Uint8Array) {
    const context = await browser.newContext()
    contexts.push(context)
    await useTestRelay(context, testRelayUrl)
    // Keep the offline-queue scenario on its controlled message server.
    // Require TURN without providing one, so direct peers cannot bypass it.
    await context.addInitScript(() => {
      localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [], stunServers: [] }))
      const NativePeerConnection = window.RTCPeerConnection
      window.RTCPeerConnection = class extends NativePeerConnection {
        constructor(configuration?: RTCConfiguration) {
          super({ ...configuration, iceTransportPolicy: 'relay', iceServers: [] })
        }
      }
    })
    await context.addInitScript(value => localStorage.setItem('iris-chat-identity', value), Buffer.from(key).toString('hex'))
    const page = await context.newPage()
    await page.route(/https:\/\/(cdn|upload|hashtree)\.iris\.to\//, route => route.abort())
    await page.goto(`${baseURL}/`)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Devices', exact: true }).click()
    const registered = page.getByText('This device', { exact: true }).first()
    const register = page.getByRole('button', { name: 'Register this device', exact: true })
    await expect(registered.or(register).first()).toBeVisible()
    if (!await registered.isVisible()) await register.click()
    await expect(registered).toBeVisible()
    await page.goto(`${baseURL}/#profile-${person}`)
    await expect(page.getByRole('button', { name: 'Favorite', exact: true })).toBeVisible()
    await page.getByText('Private details', { exact: true }).click()
    return page
  }
  try {
    const a = await device(secret), b = await device(secret)
    await a.getByRole('button', {name: 'Favorite', exact: true}).click()
    await expect(b.getByRole('button', {name: 'Favorited', exact: true})).toHaveAttribute('aria-pressed', 'true')
    await expect(a.getByTestId('profile-avatar').getByTestId('favorite-badge')).toBeVisible()
    await expect(b.getByTestId('profile-avatar').getByTestId('favorite-badge')).toBeVisible()
    await a.getByLabel('Nickname', {exact: true}).fill('Private Alice')
    await a.getByLabel('Note', {exact: true}).fill('Met at the quiet garden')
    await a.getByRole('button', {name: 'Save', exact: true}).click()
    await expect(b.getByLabel('Nickname', {exact: true})).toHaveValue('Private Alice')
    await expect(b.getByLabel('Note', {exact: true})).toHaveValue('Met at the quiet garden')
    await expect(b.getByRole('heading', {name: 'Private Alice', exact: true})).toBeVisible()
    const syncEvents = () => testRelay.publishedEvents.filter(event => event.kind === 1060)
    await expect.poll(() => syncEvents().length).toBeGreaterThan(0)
    expect(JSON.stringify(syncEvents())).not.toContain(person)
    expect(testRelay.publishedEvents.some(event => event.kind === 10452 || (event.kind === 30078 && event.tags.some(tag => tag[0] === 't' && tag[1] === 'nostr-social-memory/v1')))).toBe(false)
    expect(JSON.stringify(testRelay.publishedEvents)).not.toContain('Private Alice')
    expect(JSON.stringify(testRelay.publishedEvents)).not.toContain('Met at the quiet garden')

    testRelay.acceptFilter = event => ![30078, 1059, 1060].includes(event.kind)
    await a.getByLabel('Note', {exact: true}).fill('')
    await a.getByRole('button', {name: 'Save', exact: true}).click()
    await a.getByRole('button', {name: 'Favorited', exact: true}).click()
    await expect(a.getByRole('button', {name: 'Favorite', exact: true})).toBeVisible()
    await expect(a.getByTestId('profile-avatar').getByTestId('favorite-badge')).toHaveCount(0)
    await a.reload()
    await a.getByText('Private details', {exact: true}).click()
    await expect(a.getByLabel('Note', {exact: true})).toHaveValue('')
    await expect(a.getByLabel('Nickname', {exact: true})).toHaveValue('Private Alice')
    await expect(b.getByLabel('Note', {exact: true})).toHaveValue('Met at the quiet garden')
    testRelay.acceptFilter = undefined
    await a.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(b.getByLabel('Note', {exact: true})).toHaveValue('')
    await expect(b.getByRole('button', {name: 'Favorite', exact: true})).toBeVisible()
    await expect(b.getByTestId('profile-avatar').getByTestId('favorite-badge')).toHaveCount(0)
    const other = await device(generateSecretKey())
    await expect(other.getByTestId('profile-avatar').getByTestId('favorite-badge')).toHaveCount(0)
    await expect(other.getByLabel('Nickname', {exact: true})).toHaveValue('')
    await expect(other.getByLabel('Note', {exact: true})).toHaveValue('')
    await mkdir('work/private-contact-sync', {recursive: true})
    await b.screenshot({path: 'work/private-contact-sync/chat-desktop.png', fullPage: true})
    await a.setViewportSize({width: 390, height: 844})
    await a.screenshot({path: 'work/private-contact-sync/chat-mobile.png', fullPage: true})
  } finally {
    testRelay.acceptFilter = undefined
    for (const context of contexts) await context.close()
  }
})

test('private edits never request long-lived account encryption from an external signer', async ({ browser, testRelay, testRelayUrl, baseURL }) => {
  const { finalizeEvent } = await import('nostr-tools')
  const secret = generateSecretKey(), account = getPublicKey(secret), person = getPublicKey(generateSecretKey())
  const context = await browser.newContext()
  let encryptions = 0
  try {
    await useTestRelay(context, testRelayUrl)
    await context.exposeBinding('contactSignerSign', (_source, draft) => finalizeEvent(draft, secret))
    await context.exposeBinding('contactSignerEncrypt', () => { encryptions++; throw new Error('Private data must use device sessions') })
    await context.addInitScript(owner => {
      const bridge = window as unknown as { contactSignerSign: (draft: Parameters<NonNullable<Window['nostr']>['signEvent']>[0]) => ReturnType<NonNullable<Window['nostr']>['signEvent']>; contactSignerEncrypt: (peer: string, text: string) => Promise<string> }
      window.nostr = { getPublicKey: async () => owner, signEvent: draft => bridge.contactSignerSign(draft),
        nip44: { encrypt: (peer, text) => bridge.contactSignerEncrypt(peer, text), decrypt: (peer, text) => bridge.contactSignerEncrypt(peer, text) } }
      localStorage.setItem('iris-chat-identity', 'nip07')
    }, account)
    const page = await context.newPage()
    await page.goto(`${baseURL}/#profile-${person}`)
    await page.getByText('Private details', {exact: true}).click()
    await page.getByRole('button', {name: 'Favorite', exact: true}).click()
    await page.getByLabel('Nickname', {exact: true}).fill('Private external account')
    await page.getByRole('button', {name: 'Save', exact: true}).click()
    await expect(page.getByRole('heading', {name: 'Private external account', exact: true})).toBeVisible()
    await page.reload()
    await page.getByText('Private details', {exact: true}).click()
    await expect(page.getByLabel('Nickname', {exact: true})).toHaveValue('Private external account')
    expect(encryptions).toBe(0)
    expect(testRelay.publishedEvents.some(event => event.kind === 30078 && event.tags.some(tag => tag[0] === 't' && tag[1] === 'nostr-social-memory/v1'))).toBe(false)
  } finally { await context.close() }
})
