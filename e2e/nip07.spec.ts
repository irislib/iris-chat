import { test, expect, useTestRelay } from './fixtures'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { isGroupRosterFactEvent } from 'nostr-double-ratchet'

async function installNip07Mock(
  page: import('@playwright/test').Page,
  privateKey: Uint8Array,
  beforeSign?: (event: Parameters<typeof finalizeEvent>[0]) => void
): Promise<string> {
  const publicKey = getPublicKey(privateKey)

  await page.exposeFunction('__irisNip07SignEvent', (event: Parameters<typeof finalizeEvent>[0]) => {
    beforeSign?.(event)
    return finalizeEvent({ ...event }, privateKey)
  })

  await page.addInitScript(({ publicKey }) => {
    ;(window as Window & {
      __irisNip07SignEvent?: (event: Record<string, unknown>) => Promise<Record<string, unknown>>
      nostr?: unknown
    }).nostr = {
      getPublicKey: async () => publicKey,
      signEvent: async (event: Record<string, unknown>) =>
        (window as Window & {
          __irisNip07SignEvent: (event: Record<string, unknown>) => Promise<Record<string, unknown>>
        }).__irisNip07SignEvent(event),
      nip44: {
        encrypt: async (_pubkey: string, plaintext: string) => btoa(plaintext),
        decrypt: async (_pubkey: string, ciphertext: string) => atob(ciphertext),
      },
    }
  }, { publicKey })

  return publicKey
}

test.describe('NIP-07 Login', () => {
  test('should login with NIP-07 extension', async ({ page }) => {
    const privateKey = generateSecretKey()
    await installNip07Mock(page, privateKey)

    await page.goto('/')

    await expect(page.getByRole('button', { name: 'Login with Extension' })).toBeHidden()
    await page.getByRole('button', { name: 'Already have a profile?' }).click()

    // Should show NIP-07 login button
    const nip07Button = page.locator('button:has-text("Login with Extension")')
    await expect(nip07Button).toBeVisible()

    // Click login with extension
    await nip07Button.click()

    // Should be logged in and show home view
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 5000 })
  })

  test('should create invite with NIP-07 login', async ({ page }) => {
    const privateKey = generateSecretKey()
    await installNip07Mock(page, privateKey)

    await page.goto('/')

    // Login with NIP-07
    await page.getByRole('button', { name: 'Already have a profile?' }).click()
    await page.click('button:has-text("Login with Extension")')
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 5000 })

    // Click New Chat
    await page.getByRole('button', { name: 'New Chat' }).click()

    // Invite creation must not stay stuck on current-device relay registration.
    const copyButton = page.locator('button[title*="#"]').first()
    await expect(copyButton).toBeVisible({ timeout: 15000 })
    await expect(page.locator('text=Creating invite...')).not.toBeVisible({ timeout: 15000 })
  })

  test('should join chat via paste link with NIP-07 login', async ({ browser, testRelayUrl }) => {
    // User 1: Regular login (privkey) and create invite
    const context1 = await browser.newContext()
    await useTestRelay(context1, testRelayUrl)
    const page1 = await context1.newPage()

    await page1.goto('/')
    await page1.getByRole('button', { name: 'Go' }).click()
    await page1.getByRole('button', { name: 'New Chat' }).click()

    // Get the invite URL
    const copyButton = page1.locator('button[title*="#"]').first()
    await expect(copyButton).toBeVisible()
    const rawUrl = await copyButton.getAttribute('title')
    if (!rawUrl) throw new Error('Could not get invite URL')
    const inviteUrl = rawUrl.replace('https://chat.iris.to', new URL(page1.url()).origin)

    // User 2: NIP-07 login and join via paste link
    const context2 = await browser.newContext()
    await useTestRelay(context2, testRelayUrl)
    const page2 = await context2.newPage()

    const privateKey2 = generateSecretKey()
    await installNip07Mock(page2, privateKey2)

    await page2.goto('/')

    // Login with NIP-07
    await page2.getByRole('button', { name: 'Already have a profile?' }).click()
    await page2.click('button:has-text("Login with Extension")')
    await expect(page2.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 5000 })

    // Click New Chat and paste the invite link
    await page2.getByRole('button', { name: 'New Chat' }).click()
    await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

    // Should NOT show "Not logged in" error
    await expect(page2.locator('text=Not logged in')).not.toBeVisible({ timeout: 2000 })

    // Should successfully join and show chat input
    // Existing extension identities require both the absent-roster discovery
    // window and a fresh authorization check before the invite handshake.
    await expect(page2.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 15000 })

    await context1.close()
    await context2.close()
  })

  test('group creation recovers from rejected signing without an orphan or duplicate roster', async ({ browser, testRelayUrl, testRelay }, testInfo) => {
    test.setTimeout(120_000)
    const contexts = await Promise.all([browser.newContext(), browser.newContext()])
    const errors: string[] = []
    let rejectRoster = true
    let rosterAttempts = 0
    let signedRosters = 0
    try {
      await Promise.all(contexts.map(context => useTestRelay(context, testRelayUrl)))
      const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()))
      for (const page of [alice, bob]) page.on('pageerror', error => errors.push(error.message))
      await installNip07Mock(alice, generateSecretKey(), event => {
        if (!isGroupRosterFactEvent(event)) return
        rosterAttempts++
        if (rejectRoster) throw new Error('Group signing declined. Try again.')
        signedRosters++
      })
      await alice.goto('/')
      await alice.getByRole('button', { name: 'Already have a profile?', exact: true }).click()
      await alice.getByRole('button', { name: 'Login with Extension', exact: true }).click()
      await alice.getByRole('button', { name: 'New Chat', exact: true }).click()
      const copy = alice.locator('button[title*="#/nhash"]').first()
      await expect(copy).toBeVisible()
      const invite = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', new URL(alice.url()).origin)
      await bob.goto(invite)
      await bob.getByLabel('Your name (optional)').fill('Roster recipient')
      await bob.getByRole('button', { name: 'Join Chat', exact: true }).click()
      const send = async (page: import('@playwright/test').Page, text: string) => {
        await page.getByPlaceholder('Type a message...').fill(text)
        await page.getByRole('button', { name: 'Send', exact: true }).click()
      }
      await send(bob, 'Ready for the group')
      await expect(alice.getByTestId('sidebar-chat-list').getByText('Ready for the group', { exact: true })).toBeVisible()
      await alice.getByRole('button', { name: 'New Chat', exact: true }).click()
      await alice.getByRole('button', { name: 'Create Group', exact: true }).click()
      await alice.getByTestId('create-group-member').first().click()
      await alice.getByTestId('create-group-next').click()
      await alice.getByPlaceholder('Enter group name...').fill('Recovered signing')
      const submit = alice.getByTestId('create-group-submit')
      await submit.click()
      await expect(alice.getByRole('alert')).toContainText('Group signing declined. Try again.')
      await expect(submit).toBeEnabled()
      await expect(submit).toHaveText('Try again')
      await expect(alice.getByPlaceholder('Enter group name...')).toHaveValue('Recovered signing')
      const storedGroupCount = () => alice.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('iris-chat')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        try {
          return await new Promise<number>((resolve, reject) => {
            const request = database.transaction('groups').objectStore('groups').count()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
        } finally { database.close() }
      })
      expect(await storedGroupCount()).toBe(0)
      expect(rosterAttempts).toBe(1)
      await alice.screenshot({ path: testInfo.outputPath('signing-rejected.png') })

      rejectRoster = false
      await submit.click()
      await expect(alice.getByTestId('create-group-view')).toBeHidden()
      await expect.poll(storedGroupCount).toBe(1)
      expect(rosterAttempts).toBe(2)
      expect(signedRosters).toBe(1)
      await send(alice, 'Created after signer recovery')
      await bob.getByTestId('sidebar-chat-list').getByRole('button', { name: /Recovered signing/ }).click()
      await bob.getByRole('button', { name: 'Accept', exact: true }).click()
      await expect(bob.getByTestId('message-bubble-body').getByText('Created after signer recovery', { exact: true })).toBeVisible()
      await send(bob, 'Recovered group reply')
      await expect(alice.getByTestId('message-bubble-body').getByText('Recovered group reply', { exact: true })).toBeVisible()
      await bob.reload()
      await expect(bob.getByTestId('message-bubble-body').getByText('Created after signer recovery', { exact: true })).toBeVisible()
      await send(bob, 'Reply after recovery and reload')
      await expect(alice.getByTestId('message-bubble-body').getByText('Reply after recovery and reload', { exact: true })).toBeVisible()
      expect(testRelay.publishedEvents.filter(isGroupRosterFactEvent)).toEqual([])
      expect(errors).toEqual([])
      await bob.screenshot({ path: testInfo.outputPath('signing-recovered.png') })
    } finally { await Promise.all(contexts.map(context => context.close())) }
  })

  test('should show error when NIP-07 extension lacks nip44 support', async ({ page }) => {
    const privateKey = generateSecretKey()
    const publicKey = getPublicKey(privateKey)
    await page.exposeFunction('__irisNip07SignEvent', (event: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent({ ...event }, privateKey)
    )
    await page.addInitScript(({ publicKey }) => {
      ;(window as Window & {
        __irisNip07SignEvent: (event: Record<string, unknown>) => Promise<Record<string, unknown>>
        nostr?: unknown
      }).nostr = {
        getPublicKey: async () => publicKey,
        signEvent: async (event: Record<string, unknown>) =>
          (window as Window & {
            __irisNip07SignEvent: (event: Record<string, unknown>) => Promise<Record<string, unknown>>
          }).__irisNip07SignEvent(event),
      }
    }, { publicKey })

    await page.goto('/')

    // Login with NIP-07
    await page.getByRole('button', { name: 'Already have a profile?' }).click()
    await page.click('button:has-text("Login with Extension")')
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 5000 })

    // Click New Chat
    await page.getByRole('button', { name: 'New Chat' }).click()

    // Create a legacy invite link to trigger NIP-44 encryption error
    const legacyInvitePayload = {
      version: 2,
      inviter: publicKey,
      ephemeralKey: 'a'.repeat(64),
      sharedSecret: 'b'.repeat(64),
    }
    const legacyInviteUrl = `${new URL(page.url()).origin}/#${encodeURIComponent(JSON.stringify(legacyInvitePayload))}`
    await page.getByPlaceholder('Paste invite link').fill(legacyInviteUrl)

    // Should show NIP-44 error message
    await expect(page.locator('text=does not support NIP-44')).toBeVisible({ timeout: 5000 })
  })
})
