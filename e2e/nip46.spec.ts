import { test, expect, useTestRelay } from './fixtures'
import { TestRemoteSigner } from './nip46-signer'
import { AppKeys } from 'nostr-double-ratchet'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import type { Page } from '@playwright/test'

async function openSigner(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Signer app/device' }).click()
  const code = page.locator('button[title^="nostrconnect://"]')
  await expect(code).toBeVisible()
  return (await code.getAttribute('title'))!
}

async function storedDevice(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('iris-chat')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const rows = await new Promise<{ key: string; value: unknown }[]>((resolve, reject) => {
      const request = database.transaction('sessionManager').objectStore('sessionManager').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return { identity: localStorage.getItem('iris-chat-identity'), rows }
  })
}

test('scan signer authorizes only a device, preserves roster, reloads and messages with signer offline', async ({ page, browser, testRelay, testRelayUrl }, testInfo) => {
  test.setTimeout(120_000)
  const signer = new TestRemoteSigner(testRelayUrl)
  await signer.start()
  const oldDevice = getPublicKey(generateSecretKey())
  const old = new AppKeys([{ identityPubkey: oldDevice, createdAt: 123 }], [{ identityPubkey: oldDevice, deviceLabel: 'Existing device', updatedAt: 123 }])
  const previous = finalizeEvent(old.getEvent({ ownerPubkey: signer.ownerPubkey, ownerPrivateKey: signer.ownerSecret, createdAt: Math.floor(Date.now() / 1000) - 2 }), signer.ownerSecret)
  await signer.publish(previous)
  const peerContext = await browser.newContext()
  try {
    await page.setViewportSize({ width: 1280, height: 900 })
    const link = await openSigner(page)
    await page.screenshot({ path: testInfo.outputPath('signer-scan.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: testInfo.outputPath('signer-scan-mobile.png') })
    await page.setViewportSize({ width: 1280, height: 900 })
    await signer.acceptConnection(link, 'wrong-secret')
    await expect(page.getByRole('heading', { name: 'Signer app/device' })).toBeVisible()
    expect(signer.requests).toHaveLength(0)
    await signer.acceptConnection(link)
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()
    expect(signer.ownerPubkey).not.toBe(signer.transportPubkey)
    expect(signer.requests.filter(method => method === 'sign_event')).toHaveLength(1)
    const persisted = await storedDevice(page)
    expect(persisted.identity).toBe(`link:${signer.ownerPubkey}`)
    const device = persisted.rows.find(row => row.key === 'v1/device-manager/identity-public-key')!.value as string
    const deviceSecret = persisted.rows.find(row => row.key === 'v1/device-manager/identity-private-key')!.value as number[]
    expect(getPublicKey(new Uint8Array(deviceSecret))).toBe(device)
    expect(device).not.toBe(signer.ownerPubkey)
    expect(JSON.stringify(persisted)).not.toContain(Buffer.from(signer.ownerSecret).toString('hex'))
    expect(JSON.stringify(persisted)).not.toContain(JSON.stringify(Array.from(signer.ownerSecret)))
    const authorization = signer.signedEvents[0]
    expect(AppKeys.fromEvent(authorization as never).getAllDevices().map(entry => entry.identityPubkey)).toEqual(expect.arrayContaining([oldDevice, device]))
    expect(authorization.tags.filter(tag => tag[0] === 'encrypted_device_labels')).toEqual(previous.tags.filter(tag => tag[0] === 'encrypted_device_labels'))
    expect(testRelay.publishedEvents.some(event => event.id === authorization.id)).toBe(true)
    await signer.stop()
    await page.reload()
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()
    expect((await storedDevice(page)).rows.find(row => row.key === 'v1/device-manager/identity-public-key')?.value).toBe(device)

    await useTestRelay(peerContext, testRelayUrl)
    const peerSecret = Buffer.from(generateSecretKey()).toString('hex')
    await peerContext.addInitScript(key => { try { localStorage.setItem('iris-chat-identity', key) } catch {} }, peerSecret)
    const peer = await peerContext.newPage()
    await peer.goto('/')
    await peer.getByRole('button', { name: 'New Chat' }).click()
    const invite = peer.locator('button[title*="/invite/"]').first()
    await expect(invite).toBeVisible()
    const inviteLink = (await invite.getAttribute('title'))!
    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(inviteLink)
    await page.getByPlaceholder('Type a message...').fill('Message without signer')
    await page.getByPlaceholder('Type a message...').press('Enter')
    await expect(peer.getByText('Message without signer').first()).toBeVisible({ timeout: 30_000 })
  } finally {
    await signer.stop()
    await peerContext.close()
  }
})

test('paste signer link supports explicit approval links', async ({ page, testRelayUrl }, testInfo) => {
  const signer = new TestRemoteSigner(testRelayUrl)
  signer.holdSigning = true
  signer.authUrl = 'https://signer.example/approve'
  await signer.start()
  try {
    await openSigner(page)
    await page.getByRole('button', { name: 'Paste signer link' }).click()
    await page.getByPlaceholder('Paste signer link').fill(signer.bunkerLink)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('link', { name: 'Approve in signer' })).toHaveAttribute('href', signer.authUrl)
    await page.screenshot({ path: testInfo.outputPath('signer-paste.png') })
    await signer.releaseSigning()
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()
    expect(signer.requests[0]).toBe('connect')
  } finally { await signer.stop() }
})

for (const behavior of ['deny', 'mutate', 'cancel'] as const) {
  test(`${behavior} signer response does not sign in or publish authorization`, async ({ page, testRelay, testRelayUrl }) => {
    const signer = new TestRemoteSigner(testRelayUrl)
    signer.denySigning = behavior === 'deny'
    signer.mutateSigning = behavior === 'mutate'
    signer.holdSigning = behavior === 'cancel'
    await signer.start()
    try {
      await signer.acceptConnection(await openSigner(page))
      if (behavior === 'cancel') {
        await expect.poll(() => signer.requests.includes('sign_event')).toBe(true)
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()
        await signer.releaseSigning()
        await expect(page.getByRole('button', { name: 'Signer app/device' })).toBeVisible()
      } else {
        await expect(page.getByRole('alert')).toContainText(behavior === 'deny' ? 'declined' : 'changed')
      }
      expect(await page.evaluate(() => localStorage.getItem('iris-chat-identity'))).toBeNull()
      expect(testRelay.publishedEvents.filter(event => event.kind === 37368 && event.pubkey === signer.ownerPubkey)).toHaveLength(0)
    } finally { await signer.stop() }
  })
}

test('concurrent device authorization is rechecked before publishing', async ({ page, testRelay, testRelayUrl }) => {
  const signer = new TestRemoteSigner(testRelayUrl)
  await signer.start()
  let changedId = ''
  signer.beforeSign = async () => {
    const changed = finalizeEvent(new AppKeys([{ identityPubkey: getPublicKey(generateSecretKey()), createdAt: 1 }]).getEvent({ ownerPubkey: signer.ownerPubkey }), signer.ownerSecret)
    changedId = changed.id
    await signer.publish(changed)
  }
  try {
    await signer.acceptConnection(await openSigner(page))
    await expect(page.getByRole('alert')).toContainText('device list changed')
    const published = testRelay.publishedEvents.filter(event => event.kind === 37368 && event.pubkey === signer.ownerPubkey)
    expect(published.map(event => event.id)).toEqual([changedId])
    expect(await page.evaluate(() => localStorage.getItem('iris-chat-identity'))).toBeNull()
  } finally { await signer.stop() }
})
