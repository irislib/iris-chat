import type { Page } from '@playwright/test'
import { test, expect, useTestRelay } from './fixtures'

async function databaseState(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('iris-chat')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const read = (name: string) => new Promise<any[]>((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const [groups, messages, runtime, sessions, pendingPush] = await Promise.all(
        ['groups', 'messages', 'sessionManager', 'sessions', 'pendingPushEvents'].map(read),
      )
      return { groups, messages, runtime, sessions, pendingPush }
    } finally { db.close() }
  })
}

async function send(page: Page, content: string) {
  await page.getByPlaceholder('Type a message...').fill(content)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

for (const surface of ['details', 'chat menu'] as const) test(`${surface} deletion awaits replay erasure, preserves another group, and logout isolates the next profile`, async ({ browser, testRelayUrl }, testInfo) => {
  test.setTimeout(120_000)
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  const errors: string[] = []
  try {
    await Promise.all(contexts.map(context => useTestRelay(context, testRelayUrl)))
    const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()))
    for (const page of [alice, bob]) page.on('pageerror', error => errors.push(error.message))
    await alice.goto('/')
    await alice.getByRole('button', { name: 'Go', exact: true }).click()
    const originalIdentity = await alice.evaluate(() => localStorage.getItem('iris-chat-identity'))
    await alice.getByRole('button', { name: 'New Chat', exact: true }).click()
    const copy = alice.locator('button[title*="#/nhash"]').first()
    await expect(copy).toBeVisible()
    const invite = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', new URL(alice.url()).origin)
    await bob.goto(invite)
    await bob.getByLabel('Your name (optional)').fill('Cleanup peer')
    await bob.getByRole('button', { name: 'Join Chat', exact: true }).click()
    await send(bob, 'Ready for private groups')
    await expect(alice.getByTestId('sidebar-chat-list').getByText('Ready for private groups', { exact: true })).toBeVisible()

    const groupNames = ['Delete this private group', 'Keep this private group']
    const groupIds: string[] = []
    for (const name of groupNames) {
      await alice.getByRole('button', { name: 'New Chat', exact: true }).click()
      await alice.getByRole('button', { name: 'Create Group', exact: true }).click()
      await alice.getByTestId('create-group-member').first().click()
      await alice.getByTestId('create-group-next').click()
      await alice.getByPlaceholder('Enter group name...').fill(name)
      await alice.getByTestId('create-group-submit').click()
      await expect(alice.getByTestId('create-group-view')).toBeHidden()
      await send(alice, `Hello ${name}`)
      await bob.getByTestId('sidebar-chat-list').getByRole('button', { name: new RegExp(name) }).click()
      await bob.getByRole('button', { name: 'Accept', exact: true }).click()
      await expect(bob.getByTestId('message-bubble-body').getByText(`Hello ${name}`, { exact: true })).toBeVisible()
      await send(bob, `Private reply ${name}`)
      await expect(alice.getByTestId('message-bubble-body').getByText(`Private reply ${name}`, { exact: true })).toBeVisible()
      const state = await databaseState(alice)
      const id = state.groups.find(group => group.name === name)!.id as string
      groupIds.push(id)
      await expect.poll(async () => (await databaseState(alice)).runtime.filter(row =>
        row.key.startsWith(`v1/broadcast-channel/group/${id}/consumed-outer/`)).length).toBeGreaterThan(0)
    }

    await alice.getByTestId('sidebar-chat-list').getByRole('button', { name: new RegExp(groupNames[0]) }).click()
    if (surface === 'details') {
      await alice.locator('header button').filter({ hasText: groupNames[0] }).click()
      await alice.getByRole('button', { name: 'Delete Group', exact: true }).click()
    } else {
      await alice.getByRole('button', { name: 'Chat menu', exact: true }).click()
    }
    const confirmDelete = alice.getByRole('button', { name: surface === 'details' ? 'Delete' : 'Delete group', exact: true })
    // Real IndexedDB failure, after real encrypted traffic populated the replay cache.
    await alice.evaluate(prefix => {
      const original = IDBObjectStore.prototype.delete
      IDBObjectStore.prototype.delete = function(key) {
        if (this.name === 'sessionManager' && typeof key === 'string' && key.startsWith(prefix)) {
          IDBObjectStore.prototype.delete = original
          throw new DOMException('Temporary storage failure', 'UnknownError')
        }
        return original.call(this, key)
      }
    }, `v1/broadcast-channel/group/${groupIds[0]}/consumed-outer/`)
    await confirmDelete.click()
    await expect(alice.getByRole('alert')).toHaveText('Could not delete this group. Try again.')
    expect((await databaseState(alice)).groups.some(group => group.id === groupIds[0])).toBe(true)
    await alice.getByRole('alert').scrollIntoViewIfNeeded()
    await alice.screenshot({ path: testInfo.outputPath('group-delete-retry.png'), fullPage: true })
    await confirmDelete.click()
    await expect(alice.getByTestId('sidebar-chat-list').getByRole('button', { name: new RegExp(groupNames[0]) })).toHaveCount(0)
    const deleted = await databaseState(alice)
    expect(deleted.runtime.filter(row => row.key.startsWith(`v1/broadcast-channel/group/${groupIds[0]}/consumed-outer/`))).toEqual([])
    expect(deleted.groups.some(group => group.id === groupIds[0])).toBe(false)
    expect(deleted.messages.filter(message => message.sessionId === `group:${groupIds[0]}`)).toEqual([])
    expect(deleted.runtime.filter(row => row.key.startsWith(`v1/broadcast-channel/group/${groupIds[1]}/consumed-outer/`)).length).toBeGreaterThan(0)

    await alice.reload()
    await alice.getByTestId('sidebar-chat-list').getByRole('button', { name: new RegExp(groupNames[1]) }).click()
    await send(alice, 'Other group still works after deletion and reload')
    await expect(bob.getByTestId('message-bubble-body').getByText('Other group still works after deletion and reload', { exact: true })).toBeVisible()
    await send(bob, 'Other group reply')
    await expect(alice.getByTestId('message-bubble-body').getByText('Other group reply', { exact: true })).toBeVisible()
    await alice.screenshot({ path: testInfo.outputPath('remaining-group.png'), fullPage: true })
    await alice.getByRole('button', { name: 'Settings', exact: true }).click()
    alice.once('dialog', dialog => dialog.accept())
    await Promise.all([
      alice.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Sign out', exact: true }).click(),
      send(bob, 'Old account traffic during sign out'),
    ])
    await expect(alice.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
    expect(await databaseState(alice)).toEqual({ groups: [], messages: [], runtime: [], sessions: [], pendingPush: [] })
    await alice.reload()
    await expect(alice.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
    expect(await databaseState(alice)).toEqual({ groups: [], messages: [], runtime: [], sessions: [], pendingPush: [] })
    await alice.getByRole('button', { name: 'Go', exact: true }).click()
    await expect(alice.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
    const nextIdentity = await alice.evaluate(() => localStorage.getItem('iris-chat-identity'))
    expect(nextIdentity).toBeTruthy()
    expect(nextIdentity).not.toBe(originalIdentity)
    await send(bob, 'Old account traffic after new profile')
    await alice.reload()
    await expect(alice.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
    const isolated = await databaseState(alice)
    expect(isolated.groups).toEqual([])
    expect(isolated.messages).toEqual([])
    expect(isolated.sessions).toEqual([])
    for (const id of groupIds) expect(JSON.stringify(isolated.runtime)).not.toContain(id)
    expect(await alice.evaluate(() => localStorage.getItem('iris-chat-identity'))).toBe(nextIdentity)
    expect(errors).toEqual([])
    await alice.screenshot({ path: testInfo.outputPath('new-profile-isolated.png'), fullPage: true })
  } finally { await Promise.all(contexts.map(context => context.close())) }
})
