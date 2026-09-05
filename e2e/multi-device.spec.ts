import { test, expect, useTestRelay } from './fixtures'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const COMPACT_LINK_CODE_PATTERN = /^[0-9a-f]{64}\.[0-9a-f]{64}\.[A-Za-z0-9_-]+$/

async function setIdentity(context: import('@playwright/test').BrowserContext, privkeyHex: string) {
  await context.addInitScript((key: string) => {
    try {
      window.localStorage.setItem('iris-chat-identity', key)
    } catch {
      // ignore opaque origins (about:blank)
    }
  }, privkeyHex)
}

async function loginWithStoredKey(page: import('@playwright/test').Page) {
  await page.goto('/')
  const newChat = page.getByRole('button', { name: 'New Chat' })
  try {
    await expect(newChat).toBeVisible({ timeout: 30000 })
  } catch (err) {
    const [identity, relays, bodyText] = await Promise.all([
      page.evaluate(() => localStorage.getItem('iris-chat-identity')),
      page.evaluate(() => localStorage.getItem('iris-chat-relays')),
      page.evaluate(() => document.body?.innerText?.slice(0, 500) || ''),
    ])
    throw new Error(
      `Login timeout. identity=${identity} relays=${relays} bodyText=${bodyText}`
    )
  }
}

async function registerDevice(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('heading', { name: 'Devices' }).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const registerButton = page.getByRole('button', { name: 'Register this device' })
  const thisDeviceLabel = page.getByText('This device').first()
  try {
    if (!(await registerButton.count())) {
      await Promise.race([
        registerButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
        thisDeviceLabel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
      ])
    }
    if (await registerButton.count()) {
      await registerButton.click({ timeout: 5000 })
      await Promise.race([
        expect(registerButton).not.toBeVisible({ timeout: 20000 }).catch(() => null),
        thisDeviceLabel.waitFor({ state: 'visible', timeout: 20000 }).catch(() => null),
      ])
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (!message.includes('detached') && !message.includes('not stable')) {
      throw err
    }
    // Button likely disappeared due to auto-registration; continue.
  }
  await page.getByRole('button', { name: 'Back' }).click()
}

async function waitForNextCreatedAtSecond(): Promise<void> {
  const currentSecond = Math.floor(Date.now() / 1000)
  while (Math.floor(Date.now() / 1000) === currentSecond) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function openChatFromList(page: import('@playwright/test').Page, message: string): Promise<void> {
  const chatList = page.getByTestId('sidebar-chat-list')
  const listItemName = new RegExp(escapeRegExp(message))

  const allTab = page.getByTestId('sidebar-tab-all')
  const requestsTab = page.getByTestId('sidebar-tab-requests')
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    for (const tabButton of [allTab, requestsTab]) {
      await tabButton.click().catch(() => {})
      const listItemByRole = chatList.getByRole('button', { name: listItemName }).first()
      const listItemByText = chatList.locator('button').filter({ hasText: message }).first()
      for (const listItem of [listItemByRole, listItemByText]) {
        if (await listItem.isVisible().catch(() => false)) {
          await listItem.scrollIntoViewIfNeeded().catch(() => {})
          await listItem.click()
          return
        }
      }
    }
    await page.waitForTimeout(250)
  }

  throw new Error(`Could not find chat list item for message preview: ${message}`)
}

async function openGroupFromSidebar(page: import('@playwright/test').Page, groupName: string): Promise<void> {
  const chatList = page.getByTestId('sidebar-chat-list')
  const groupPattern = new RegExp(escapeRegExp(groupName))
  const allTab = page.getByTestId('sidebar-tab-all')
  const requestsTab = page.getByTestId('sidebar-tab-requests')
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    for (const tabButton of [allTab, requestsTab]) {
      await tabButton.click().catch(() => {})
      const byRole = chatList.getByRole('button', { name: groupPattern }).first()
      const byText = chatList.locator('button').filter({ hasText: groupName }).first()
      for (const candidate of [byRole, byText]) {
        if (await candidate.isVisible().catch(() => false)) {
          await candidate.scrollIntoViewIfNeeded().catch(() => {})
          await candidate.click()
          return
        }
      }
    }
    await page.waitForTimeout(250)
  }

  throw new Error(`Could not find group list item: ${groupName}`)
}

async function waitForIncomingRequest(page: import('@playwright/test').Page, message: string): Promise<void> {
  const messageBubble = page.locator('.max-w-\\[85\\%\\]').filter({ hasText: message }).first()
  const requestHeader = page.getByRole('heading', { name: 'Message request' })
  const chatList = page.getByTestId('sidebar-chat-list')
  const requestsTab = page.getByTestId('sidebar-tab-requests')
  const deadline = Date.now() + 45_000

  while (Date.now() < deadline) {
    if (await messageBubble.isVisible().catch(() => false)) {
      return
    }

    await requestsTab.click().catch(() => {})

    if (
      (await requestHeader.isVisible().catch(() => false)) &&
      (await messageBubble.isVisible().catch(() => false))
    ) {
      return
    }

    const requestItemByText = chatList.locator('button').filter({ hasText: message }).first()
    if (await requestItemByText.isVisible().catch(() => false)) {
      await requestItemByText.click()
      await expect(messageBubble).toBeVisible({ timeout: 15000 })
      return
    }

    const requestItem = chatList.locator('button').first()
    if (await requestItem.isVisible().catch(() => false)) {
      await requestItem.click()
      await expect(messageBubble).toBeVisible({ timeout: 15000 })
      return
    }

    await page.waitForTimeout(250)
  }

  throw new Error(`Timed out waiting for incoming request with message: ${message}`)
}

async function getInviteUrl(page: import('@playwright/test').Page): Promise<string> {
  const copyButton = page.locator('button[title*="#"]').first()
  await expect(copyButton).toBeVisible({ timeout: 10000 })
  const url = await copyButton.getAttribute('title')
  if (!url) throw new Error('Could not get invite URL')
  return url.replace('https://chat.iris.to', new URL(page.url()).origin)
}

async function getLinkInviteUrl(page: import('@playwright/test').Page): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const buttons = page.locator('button[title]')
    const count = await buttons.count()
    for (let index = 0; index < count; index += 1) {
      const url = await buttons.nth(index).getAttribute('title')
      if (url?.match(COMPACT_LINK_CODE_PATTERN)) return url
    }
    await page.waitForTimeout(100)
  }
  throw new Error('Could not get compact link invite code')
}

async function openLinkThisDevice(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/')
  const linkButton = page.getByRole('button', { name: /link this device/i })
  if (!(await linkButton.isVisible().catch(() => false))) {
    await page.evaluate(() => {
      localStorage.removeItem('iris-chat-identity')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
  }

  await expect(linkButton).toBeVisible({ timeout: 30000 })
  await linkButton.click()
  await expect(page.getByRole('heading', { name: 'Link this device' })).toBeVisible({
    timeout: 20000,
  })
}

async function acceptLinkInvite(page: import('@playwright/test').Page, inviteUrl: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Link another device' }).click()
  await waitForNextCreatedAtSecond()
  await page.getByPlaceholder('Paste link code').fill(inviteUrl)
  await expect(page.getByRole('heading', { name: 'Link another device' })).toBeHidden({
    timeout: 750,
  })
  await page.getByRole('button', { name: 'Back' }).click()
}

test('syncs outgoing messages to another device', async ({ browser, testRelayUrl }) => {
  test.slow()

  const ownerPrivkey = generateSecretKey()
  const ownerPrivkeyHex = toHex(ownerPrivkey)

  const user2Privkey = generateSecretKey()
  const user2PrivkeyHex = toHex(user2Privkey)

  const contextOwner = await browser.newContext()
  const contextLinked = await browser.newContext()
  const contextUser2 = await browser.newContext()

  await useTestRelay(contextOwner, testRelayUrl)
  await useTestRelay(contextLinked, testRelayUrl)
  await useTestRelay(contextUser2, testRelayUrl)

  await setIdentity(contextOwner, ownerPrivkeyHex)
  await contextLinked.addInitScript(() => {
    localStorage.removeItem('iris-chat-identity')
  })
  await setIdentity(contextUser2, user2PrivkeyHex)

  const ownerPage = await contextOwner.newPage()
  const linkedPage = await contextLinked.newPage()
  const user2Page = await contextUser2.newPage()

  try {
    await loginWithStoredKey(ownerPage)
    await loginWithStoredKey(user2Page)

    await registerDevice(ownerPage)
    await openLinkThisDevice(linkedPage)
    const linkInviteUrl = await getLinkInviteUrl(linkedPage)
    await acceptLinkInvite(ownerPage, linkInviteUrl)
    await expect(linkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 20000 })

    // User 2 creates a chat link
    await user2Page.getByRole('button', { name: 'New Chat' }).click()
    const inviteUrl = await getInviteUrl(user2Page)

    // Owner device joins chat and sends a message
    await ownerPage.getByRole('button', { name: 'New Chat' }).click()
    await ownerPage.getByPlaceholder('Paste invite link').fill(inviteUrl)
    await expect(ownerPage.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 15000 })

    const message = 'Hello from device 1'
    await ownerPage.getByPlaceholder('Type a message...').fill(message)
    await ownerPage.getByRole('button', { name: 'Send' }).click()

    // Linked device should see the message via multi-device sync
    await openChatFromList(linkedPage, message)
    await expect(
      linkedPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: message }).first()
    ).toBeVisible({ timeout: 20000 })

    // Sanity: user2 should receive the message too.
    await waitForIncomingRequest(user2Page, message)
  } finally {
    await contextOwner.close()
    await contextLinked.close()
    await contextUser2.close()
  }
})

test('self-chat syncs to linked device', async ({ browser, testRelayUrl }) => {
  const ownerPrivkey = generateSecretKey()
  const ownerPubkey = getPublicKey(ownerPrivkey)
  const ownerPrivkeyHex = toHex(ownerPrivkey)

  const contextOwner = await browser.newContext()
  const contextLinked = await browser.newContext()

  await useTestRelay(contextOwner, testRelayUrl)
  await useTestRelay(contextLinked, testRelayUrl)
  await setIdentity(contextOwner, ownerPrivkeyHex)
  await contextLinked.addInitScript(() => {
    localStorage.removeItem('iris-chat-identity')
  })

  const ownerPage = await contextOwner.newPage()
  const linkedPage = await contextLinked.newPage()

  try {
    await loginWithStoredKey(ownerPage)

    await registerDevice(ownerPage)

    await openLinkThisDevice(linkedPage)
    const linkInviteUrl = await getLinkInviteUrl(linkedPage)

    await acceptLinkInvite(ownerPage, linkInviteUrl)
    await expect(linkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 20000 })

    await ownerPage.getByRole('button', { name: 'New Chat' }).click()
    const selfInviteUrl = `${new URL(ownerPage.url()).origin}/#${nip19.npubEncode(ownerPubkey)}`
    await ownerPage.getByPlaceholder('Paste invite link').fill(selfInviteUrl)
    await expect(ownerPage.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 15000 })

    const message = 'Hello to myself'
    await ownerPage.getByPlaceholder('Type a message...').fill(message)
    await ownerPage.getByRole('button', { name: 'Send' }).click()
    await expect(
      ownerPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: message }).first()
    ).toBeVisible({ timeout: 20000 })

    await openChatFromList(linkedPage, message)
    await expect(
      linkedPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: message }).first()
    ).toBeVisible({ timeout: 20000 })
  } finally {
    await contextOwner.close()
    await contextLinked.close()
  }
})

test('linked device-created group syncs without approval and carries messages both ways', async ({
  browser,
  testRelayUrl,
}) => {
  test.slow()

  const ownerPrivkey = generateSecretKey()
  const ownerPrivkeyHex = toHex(ownerPrivkey)

  const user2Privkey = generateSecretKey()
  const user2PrivkeyHex = toHex(user2Privkey)

  const ownerContext = await browser.newContext()
  const linkedContext = await browser.newContext()
  const user2Context = await browser.newContext()

  await useTestRelay(ownerContext, testRelayUrl)
  await useTestRelay(linkedContext, testRelayUrl)
  await useTestRelay(user2Context, testRelayUrl)

  await setIdentity(ownerContext, ownerPrivkeyHex)
  await linkedContext.addInitScript(() => {
    localStorage.removeItem('iris-chat-identity')
  })
  await setIdentity(user2Context, user2PrivkeyHex)

  const ownerPage = await ownerContext.newPage()
  const linkedPage = await linkedContext.newPage()
  const user2Page = await user2Context.newPage()

  try {
    await loginWithStoredKey(ownerPage)
    await loginWithStoredKey(user2Page)
    await registerDevice(ownerPage)

    await openLinkThisDevice(linkedPage)
    const linkInviteUrl = await getLinkInviteUrl(linkedPage)
    await acceptLinkInvite(ownerPage, linkInviteUrl)
    await expect(linkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible({
      timeout: 20_000,
    })

    await user2Page.getByRole('button', { name: 'New Chat' }).click()
    const inviteUrl = await getInviteUrl(user2Page)

    await linkedPage.getByRole('button', { name: 'New Chat' }).click()
    await linkedPage.getByPlaceholder('Paste invite link').fill(inviteUrl)
    await expect(linkedPage.getByPlaceholder('Type a message...')).toBeVisible({
      timeout: 15_000,
    })

    const groupName = `linked-group-${Date.now()}`
    await linkedPage.getByRole('button', { name: 'New Chat' }).click()
    await linkedPage.getByRole('button', { name: 'Create Group' }).click()
    const createGroupView = linkedPage.getByTestId('create-group-view')
    await createGroupView.getByTestId('create-group-member').first().click()
    await createGroupView.getByTestId('create-group-next').click()
    await linkedPage.getByPlaceholder('Enter group name...').fill(groupName)
    await createGroupView.getByTestId('create-group-submit').click()
    await expect(linkedPage.getByText(groupName).first()).toBeVisible({ timeout: 20_000 })

    await openGroupFromSidebar(ownerPage, groupName)
    await expect(ownerPage.getByRole('button', { name: /^Accept$/ })).toHaveCount(0)

    const linkedMessage = `linked group hello ${Date.now()}`
    await linkedPage.getByPlaceholder('Type a message...').fill(linkedMessage)
    await linkedPage.getByRole('button', { name: 'Send' }).click()
    await expect(
      ownerPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: linkedMessage }).first()
    ).toBeVisible({ timeout: 20_000 })

    const ownerMessage = `owner group reply ${Date.now()}`
    await ownerPage.getByPlaceholder('Type a message...').fill(ownerMessage)
    await ownerPage.getByRole('button', { name: 'Send' }).click()
    await expect(
      linkedPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: ownerMessage }).first()
    ).toBeVisible({ timeout: 20_000 })
  } finally {
    await ownerContext.close()
    await linkedContext.close()
    await user2Context.close()
  }
})
