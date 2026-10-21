import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'
import { buildGroupRosterFactEvent, type GroupData } from 'nostr-double-ratchet'
import { test, expect } from './fixtures'

import { GroupFarmDevice } from './group-runtime-farm'
import { PrivateGroupWire } from './private-group-wire'

test('admin removal keeps history, cancels attachments, and stays read-only after reload', async ({ page, testRelay }, testInfo) => {
  const memberKey = generateSecretKey()
  const adminKey = generateSecretKey()
  const member = getPublicKey(memberKey)
  const admin = getPublicKey(adminKey)
  const group: GroupData = { id: 'removal-history', name: 'Weekend plans', members: [admin, member], admins: [admin], createdAt: Date.now() }
  const roster = (revision: number, members: string[]) => finalizeEvent(buildGroupRosterFactEvent(
    { ...group, members }, { signerPubkey: admin, revision, eventCreatedAt: Math.floor(Date.now() / 1000) + revision },
  ), adminKey)
  const initial = roster(1, group.members)
  const wire = new PrivateGroupWire()
  testRelay.authRequired = true
  testRelay.observeWire = wire.observe
  const sender = new GroupFarmDevice(admin, testRelay.url, adminKey)
  await sender.start()
  await sender.register([sender])
  await sender.runtime.upsertGroup(group)
  const deliver = (event: ReturnType<typeof roster>) => sender.runtime.sendEvent(member, {
    kind: event.kind, content: event.content, tags: event.tags, pubkey: event.pubkey,
    created_at: event.created_at, id: event.id,
  }, undefined, { includeLocalSiblings: false })
  try {
    await page.context().addInitScript(secret => {
      localStorage.setItem('iris-chat-identity', secret)
      localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [], stunServers: [] }))
    }, Buffer.from(memberKey).toString('hex'))
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Devices', exact: true }).click()
    await page.getByRole('button', { name: 'Register this device' }).click()
    await expect(page.getByText('This device').first()).toBeVisible()
    await page.getByRole('button', { name: 'Back' }).click()
    await page.getByRole('button', { name: 'Back' }).click()
    await deliver(initial)
    await page.getByText('Weekend plans', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Accept', exact: true }).click()
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Keep this conversation history')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Keep this conversation history', { exact: true }).last()).toBeVisible()

    let releaseUpload!: () => void
    const uploadWait = new Promise<void>(resolve => { releaseUpload = resolve })
    let uploads = 0
    await page.route(/https:\/\/(cdn|upload|hashtree)\.iris\.to\//, async route => {
      if (route.request().method() !== 'PUT' || !route.request().url().endsWith('/upload')) {
        await route.fulfill({ status: 404 }); return
      }
      uploads++
      await uploadWait
      await route.fulfill({ status: 201, json: { sha256: route.request().headers()['x-sha-256'] } })
    })
    await page.locator('input[type=file]').setInputFiles({ name: 'Pending.txt', mimeType: 'text/plain', buffer: Buffer.from('Private attachment') })
    await expect(page.getByTestId('attachment-preview')).toHaveCount(1)
    await expect.poll(() => uploads).toBeGreaterThan(0)
    await input.fill('Unsent draft')
    await deliver(roster(2, [admin]))
    await sender.runtime.upsertGroup({ ...group, members: [admin] })
    await expect(page.getByRole('status').filter({ hasText: 'You were removed from the group' })).toBeVisible()
    await expect(input).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Attach file', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await expect(page.getByTestId('attachment-preview')).toHaveCount(0)
    releaseUpload()
    await expect(page.getByText('Keep this conversation history', { exact: true }).last()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('removed-desktop.png'), fullPage: true })

    await page.reload()
    await expect(page.getByText('You were removed from the group', { exact: true })).toBeVisible()
    await expect(input).toBeDisabled()
    await deliver(initial)
    await expect(input).toBeDisabled()
    await expect(page.getByText('Keep this conversation history', { exact: true }).last()).toBeVisible()
    await expect(page.getByTestId('attachment-preview')).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByText('You were removed from the group', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('removed-mobile.png'), fullPage: true })
    wire.assertPrivate([admin, member, sender.getState().currentDevicePubkey!], [...sender.groupAuthors])
  } finally { await sender.stop(); testRelay.observeWire = undefined }
})
