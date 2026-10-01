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
    await context.addInitScript(value => localStorage.setItem('iris-chat-identity', value), Buffer.from(key).toString('hex'))
    const page = await context.newPage()
    await page.route(/https:\/\/(cdn|upload|hashtree)\.iris\.to\//, route => route.abort())
    await page.goto(`${baseURL}/#profile-${person}`)
    await expect(page.getByRole('button', { name: 'Favorite', exact: true })).toBeVisible()
    await page.getByText('Private details', { exact: true }).click()
    return page
  }
  try {
    const a = await device(secret), b = await device(secret)
    await a.getByRole('button', {name: 'Favorite', exact: true}).click()
    await expect(b.getByRole('button', {name: 'Favorited', exact: true})).toHaveAttribute('aria-pressed', 'true')
    await a.getByLabel('Nickname', {exact: true}).fill('Private Alice')
    await a.getByLabel('Note', {exact: true}).fill('Met at the quiet garden')
    await a.getByRole('button', {name: 'Save', exact: true}).click()
    await expect(b.getByLabel('Nickname', {exact: true})).toHaveValue('Private Alice')
    await expect(b.getByLabel('Note', {exact: true})).toHaveValue('Met at the quiet garden')
    await expect(b.getByRole('heading', {name: 'Private Alice', exact: true})).toBeVisible()
    const syncEvents = () => testRelay.publishedEvents.filter(event => event.kind === 30078 && event.pubkey === account)
    await expect.poll(() => syncEvents().length).toBeGreaterThan(0)
    expect(JSON.stringify(syncEvents())).not.toContain(person)
    expect(JSON.stringify(testRelay.publishedEvents)).not.toContain('Private Alice')
    expect(JSON.stringify(testRelay.publishedEvents)).not.toContain('Met at the quiet garden')

    testRelay.acceptFilter = event => ![30078, 1059, 1060].includes(event.kind)
    await a.getByLabel('Note', {exact: true}).fill('')
    await a.getByRole('button', {name: 'Save', exact: true}).click()
    await a.getByRole('button', {name: 'Favorited', exact: true}).click()
    await expect(a.getByRole('button', {name: 'Favorite', exact: true})).toBeVisible()
    await a.reload()
    await a.getByText('Private details', {exact: true}).click()
    await expect(a.getByLabel('Note', {exact: true})).toHaveValue('')
    await expect(a.getByLabel('Nickname', {exact: true})).toHaveValue('Private Alice')
    await expect(b.getByLabel('Note', {exact: true})).toHaveValue('Met at the quiet garden')
    testRelay.acceptFilter = undefined
    await a.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(b.getByLabel('Note', {exact: true})).toHaveValue('')
    await expect(b.getByRole('button', {name: 'Favorite', exact: true})).toBeVisible()
    const other = await device(generateSecretKey())
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

test('a declined signer pauses automatic prompts until Retry sync', async ({ browser, testRelayUrl, baseURL }) => {
  const { finalizeEvent, nip44 } = await import('nostr-tools')
  const secret = generateSecretKey(), account = getPublicKey(secret), person = getPublicKey(generateSecretKey())
  const context = await browser.newContext()
  let prompts = 0, approve = false
  try {
    await useTestRelay(context, testRelayUrl)
    await context.exposeBinding('contactSignerSign', (_source, draft) => finalizeEvent(draft, secret))
    await context.exposeBinding('contactSignerEncrypt', (_source, peer, plaintext) => {
      prompts++
      if (!approve) throw new Error('User declined')
      return nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(secret, peer))
    })
    await context.exposeBinding('contactSignerDecrypt', (_source, peer, ciphertext) => nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(secret, peer)))
    await context.addInitScript(owner => {
      const bridge = window as unknown as { contactSignerSign: (draft: unknown) => Promise<any>; contactSignerEncrypt: (peer: string, text: string) => Promise<string>; contactSignerDecrypt: (peer: string, text: string) => Promise<string> }
      window.nostr = { getPublicKey: async () => owner, signEvent: draft => bridge.contactSignerSign(draft),
        nip44: { encrypt: (peer, text) => bridge.contactSignerEncrypt(peer, text), decrypt: (peer, text) => bridge.contactSignerDecrypt(peer, text) } }
      localStorage.setItem('iris-chat-identity', 'nip07')
    }, account)
    const page = await context.newPage()
    await page.goto(`${baseURL}/#profile-${person}`)
    await page.getByText('Private details', {exact: true}).click()
    await page.getByRole('button', {name: 'Favorite', exact: true}).click()
    await expect(page.getByRole('button', {name: 'Retry sync', exact: true})).toBeVisible()
    expect(prompts).toBe(1)
    // Local edits and reconnect signals cannot reopen a declined permission prompt.
    await page.getByLabel('Nickname', {exact: true}).fill('Saved while paused')
    await page.getByRole('button', {name: 'Save', exact: true}).click()
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(page.getByRole('heading', {name: 'Saved while paused', exact: true})).toBeVisible()
    expect(prompts).toBe(1)
    approve = true
    await page.getByRole('button', {name: 'Retry sync', exact: true}).click()
    await expect.poll(() => prompts).toBe(2)
    await expect(page.getByRole('button', {name: 'Retry sync', exact: true})).toHaveCount(0)
  } finally { await context.close() }
})
