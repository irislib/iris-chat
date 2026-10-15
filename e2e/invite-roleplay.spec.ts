import { test, expect, useTestRelay } from './fixtures'
import type { Page } from '@playwright/test'

const composer = (page: Page) => page.getByPlaceholder('Type a message...')
async function send(page: Page, content: string) {
  await composer(page).fill(content)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

test('a third member reaches both existing members without creating empty direct chats', async ({ browser, testRelayUrl, testRelay }, testInfo) => {
  test.setTimeout(120_000)
  // Membership changes must reach members even if a relay suppresses public replaceable facts.
  testRelay.deliveryFilter = event => !event.tags.some(tag => tag[0] === 'type' && tag[1] === 'group_roster')
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()])
  try {
    await Promise.all(contexts.map(context => useTestRelay(context, testRelayUrl)))
    const [alice, bob, cara] = await Promise.all(contexts.map(context => context.newPage()))
    for (const [index, page] of [alice, bob, cara].entries()) page.on('console', message => { if (/group|roster/i.test(message.text()) && ['warning', 'error'].includes(message.type())) console.log(`roleplay ${index}: ${message.text()}`) })
    for (const page of [alice, bob, cara]) {
      await page.context().addInitScript(() => localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [], stunServers: [] })))
    }
    await alice.goto('/')
    await alice.getByLabel('Your name (optional)').fill('Alice')
    await alice.getByRole('button', { name: 'Go', exact: true }).click()
    const copy = alice.locator('button[title*="#/nhash"]').first()
    await expect(copy).toBeVisible()
    const link = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', new URL(alice.url()).origin)
    for (const [page, name] of [[bob, 'Bob'], [cara, 'Cara Bobcat']] as const) {
      await page.goto(link)
      await page.getByLabel('Your name (optional)').fill(name)
      await page.getByRole('button', { name: 'Join Chat', exact: true }).click()
      await expect(composer(page)).toBeVisible()
      await send(page, `Hello from ${name}`)
      await expect(alice.getByTestId('sidebar-chat-list').getByText(`Hello from ${name}`, { exact: true })).toBeVisible()
    }
    await alice.getByRole('button', { name: 'New Chat', exact: true }).click()
    await alice.getByRole('button', { name: 'Create Group', exact: true }).click()
    // A substring match for Bob must not select Cara Bobcat (or a generated Bobcat name).
    await expect(alice.getByTestId('create-group-member').getByText('Cara Bobcat', { exact: true })).toBeVisible()
    await alice.getByTestId('create-group-member').filter({ has: alice.getByText('Bob', { exact: true }) }).click()
    await alice.getByTestId('create-group-next').click()
    await alice.getByPlaceholder('Enter group name...').fill('Picnic')
    await alice.getByTestId('create-group-submit').click()
    await send(alice, 'Saturday noon')
    await bob.getByTestId('sidebar-chat-list').getByRole('button', { name: /Picnic/ }).click()
    await bob.getByRole('button', { name: 'Accept', exact: true }).click()
    await send(bob, 'I can make it')
    await expect(alice.getByText('I can make it', { exact: true }).last()).toBeVisible()

    await alice.getByRole('button', { name: 'Picnic 2 members', exact: true }).click()
    await alice.getByRole('button', { name: 'Add', exact: true }).click()
    await alice.getByRole('button', { name: 'Cara Bobcat Cara Bobcat', exact: true }).click()
    await alice.getByTestId('sidebar-chat-list').getByRole('button', { name: /Picnic/ }).click()
    await cara.getByTestId('sidebar-chat-list').getByRole('button', { name: /Picnic/ }).click()
    await cara.getByRole('button', { name: 'Accept', exact: true }).click()
    await send(cara, 'I will bring strawberries')
    for (const page of [alice, bob]) {
      await expect(page.getByText('I will bring strawberries', { exact: true }).last()).toBeVisible({ timeout: 15_000 })
    }
    await alice.reload()
    await expect(alice.getByText('I will bring strawberries', { exact: true }).last()).toBeVisible()
    for (const page of [bob, cara]) {
      await expect(page.getByTestId('sidebar-chat-list').getByText('No messages yet', { exact: true })).toHaveCount(0)
    }
  } finally {
    if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach('group-roster-events', {body: JSON.stringify(testRelay.publishedEvents.filter(event => event.tags.some(tag => tag[0] === 'type' && tag[1] === 'group_roster'))), contentType:'application/json'})
    await Promise.all(contexts.map(context => context.close()))
  }
})

test('a private group link admits a new person after an admin restart and enforces its use limit', async ({ browser, testRelayUrl }) => {
  test.setTimeout(120_000)
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()))
  try {
    await Promise.all(contexts.map(context => useTestRelay(context, testRelayUrl)))
    const [alice, bob, cara, dana] = await Promise.all(contexts.map(context => context.newPage()))
    await alice.goto('/')
    await alice.getByLabel('Your name (optional)').fill('Alice')
    await alice.getByRole('button', { name: 'Go', exact: true }).click()
    const copy = alice.locator('button[title*="#/nhash"]').first()
    await expect(copy).toBeVisible()
    const personalLink = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', new URL(alice.url()).origin)
    await bob.goto(personalLink)
    await expect(bob.getByRole('main').getByText('Chat with Alice', { exact: true })).toBeVisible()
    await bob.getByLabel('Your name (optional)').fill('Bob')
    await bob.getByRole('button', { name: 'Join Chat', exact: true }).click()
    await send(bob, 'Hello Alice')
    await expect(alice.getByText('Hello Alice', { exact: true }).last()).toBeVisible()
    await alice.getByRole('button', { name: 'New Chat', exact: true }).click()
    await alice.getByRole('button', { name: 'Create Group', exact: true }).click()
    await alice.getByTestId('create-group-member').filter({ has: alice.getByText('Bob', { exact: true }) }).click()
    await alice.getByTestId('create-group-next').click()
    await alice.getByPlaceholder('Enter group name...').fill('Weekend picnic')
    await alice.getByTestId('create-group-submit').click()
    await send(alice, 'Before Cara joined')
    await bob.getByTestId('sidebar-chat-list').getByRole('button', { name: /Weekend picnic/ }).click()
    await bob.getByRole('button', { name: 'Accept', exact: true }).click()
    await alice.getByRole('button', { name: 'Weekend picnic 2 members', exact: true }).click()
    await alice.getByRole('button', { name: 'Invite link', exact: true }).click()
    await alice.getByLabel('Use limit').selectOption('1')
    await alice.getByRole('button', { name: 'Create invite link', exact: true }).click()
    await expect(copy).toBeVisible()
    const groupLink = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', new URL(alice.url()).origin)
    const adminUrl = alice.url()
    await alice.goto('about:blank')
    await cara.goto(groupLink)
    await expect(cara.getByRole('main').getByText('Join Weekend picnic', { exact: true })).toBeVisible()
    await cara.getByLabel('Your name (optional)').fill('Cara')
    await cara.getByRole('button', { name: 'Join Group', exact: true }).click()
    await expect(cara.getByText('Waiting for the group admin to connect…', { exact: true })).toBeVisible()
    await alice.goto(adminUrl)
    await cara.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(cara.getByText('Before Cara joined', { exact: true })).toHaveCount(0)
    await send(cara, 'I brought strawberries')
    await alice.getByTestId('sidebar-chat-list').getByRole('button', { name: /Weekend picnic/ }).click()
    for (const page of [alice, bob]) await expect(page.getByText('I brought strawberries', { exact: true }).last()).toBeVisible()
    await expect(cara.getByTestId('sidebar-chat-list').locator('button')).toHaveCount(1)
    await expect(alice.getByTestId('sidebar-chat-list').getByText('No messages yet', { exact: true })).toHaveCount(0)
    await dana.goto(groupLink)
    await expect(dana.getByRole('button', { name: 'Join Group', exact: true })).toBeVisible()
    await dana.getByRole('button', { name: 'Join Group', exact: true }).click()
    await expect(dana.getByText('This invite has reached its use limit.', { exact: true })).toBeVisible()
    await expect(dana.getByPlaceholder('Type a message...')).toHaveCount(0)
  } finally { await Promise.all(contexts.map(context => context.close())) }
})
