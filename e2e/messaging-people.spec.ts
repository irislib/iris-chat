import { test, expect } from './fixtures'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { AppKeys } from 'nostr-double-ratchet'
import { WebSocket } from 'ws'

async function publish(url: string, events: ReturnType<typeof finalizeEvent>[]) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Set(events.map(event => event.id))
    const timer = setTimeout(() => { ws.close(); reject(new Error('Publishing test profiles timed out')) }, 5000)
    ws.on('error', reject)
    ws.on('open', () => { for (const event of events) ws.send(JSON.stringify(['EVENT', event])) })
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString())
      if (message[0] !== 'OK') return
      pending.delete(message[1])
      if (!pending.size) { clearTimeout(timer); ws.close(); resolve() }
    })
  })
}

test('finds only messaging users, supports user IDs, and opens a chat', async ({ page, testRelayUrl }, testInfo) => {
  const local = generateSecretKey()
  const supported = generateSecretKey()
  const unsupported = generateSecretKey()
  const revoked = generateSecretKey()
  const supportedKey = getPublicKey(supported)
  const device = getPublicKey(generateSecretKey())
  const time = Math.floor(Date.now() / 1000)
  const snapshot = (key: Uint8Array, devices: string[], createdAt: number) => finalizeEvent(new AppKeys(devices.map(identityPubkey => ({ identityPubkey, createdAt }))).getEvent({
    ownerPrivateKey: key, ownerPubkey: getPublicKey(key),
    profileId: '123e4567-e89b-42d3-a456-426614174000', createdAt,
  }), key)
  const metadata = (key: Uint8Array, name: string) => finalizeEvent({ kind: 0, created_at: time, tags: [], content: JSON.stringify({ name }) }, key)
  await publish(testRelayUrl, [
    finalizeEvent({ kind: 3, created_at: time, tags: [supported, unsupported, revoked].map(key => ['p', getPublicKey(key)]), content: '' }, local),
    metadata(supported, 'Alice Ready'), metadata(unsupported, 'Bob Unknown'), metadata(revoked, 'Carol Revoked'),
    snapshot(supported, [device], time), snapshot(revoked, [], time),
  ])
  await page.addInitScript(key => { localStorage.setItem('iris-chat-identity', key) }, Buffer.from(local).toString('hex'))
  await page.goto('/')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const people = page.getByRole('region', { name: 'Find people' })
  const alice = people.getByRole('button', { name: 'Alice Ready' })
  await expect(alice).toBeVisible()
  await expect(people.getByRole('button', { name: 'Bob Unknown' })).toHaveCount(0)
  await expect(people.getByRole('button', { name: 'Carol Revoked' })).toHaveCount(0)
  const search = people.getByRole('textbox', { name: 'Search people' })
  await search.fill('alice')
  await expect(alice).toBeVisible()
  await search.fill(nip19.npubEncode(getPublicKey(unsupported)))
  await expect(people.getByText('No people found', { exact: true })).toBeVisible()
  await search.fill(nip19.npubEncode(supportedKey))
  await expect(alice).toBeVisible()
  await search.fill('Alice')
  await page.screenshot({ path: testInfo.outputPath('find-people-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await alice.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('find-people-mobile.png'), fullPage: true })
  await alice.click()
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
})

test('removes a visible person when their messaging devices are revoked', async ({ page, testRelayUrl }) => {
  const local = generateSecretKey()
  const owner = generateSecretKey()
  const time = Math.floor(Date.now() / 1000)
  const snapshot = (devices: string[], createdAt: number) => finalizeEvent(new AppKeys(devices.map(identityPubkey => ({ identityPubkey, createdAt }))).getEvent({
    ownerPrivateKey: owner, ownerPubkey: getPublicKey(owner), profileId: '123e4567-e89b-42d3-a456-426614174000', createdAt,
  }), owner)
  await publish(testRelayUrl, [
    finalizeEvent({ kind: 3, created_at: time, tags: [['p', getPublicKey(owner)]], content: '' }, local),
    finalizeEvent({ kind: 0, created_at: time, tags: [], content: JSON.stringify({ name: 'Alice Available' }) }, owner),
    snapshot([getPublicKey(generateSecretKey())], time),
  ])
  await page.addInitScript(key => { localStorage.setItem('iris-chat-identity', key) }, Buffer.from(local).toString('hex'))
  await page.goto('/')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const people = page.getByRole('region', { name: 'Find people' })
  await expect(people.getByRole('button', { name: 'Alice Available' })).toBeVisible()
  await publish(testRelayUrl, [snapshot([], time + 1)])
  await expect(people.getByRole('button', { name: 'Alice Available' })).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(people.getByText('No people found', { exact: true })).toBeVisible()
})

test('restores verified followed people when the message server has no data', async ({ page, testRelay, testRelayUrl }) => {
  const local = generateSecretKey()
  const owner = generateSecretKey()
  const time = Math.floor(Date.now() / 1000)
  await publish(testRelayUrl, [
    finalizeEvent({ kind: 3, created_at: time, tags: [['p', getPublicKey(owner)]], content: '' }, local),
    finalizeEvent({ kind: 0, created_at: time, tags: [], content: JSON.stringify({ name: 'Alice Cached' }) }, owner),
    finalizeEvent(new AppKeys([{ identityPubkey: getPublicKey(generateSecretKey()), createdAt: time }]).getEvent({
      ownerPrivateKey: owner, ownerPubkey: getPublicKey(owner), profileId: '123e4567-e89b-42d3-a456-426614174000', createdAt: time,
    }), owner),
  ])
  await page.addInitScript(key => { localStorage.setItem('iris-chat-identity', key) }, Buffer.from(local).toString('hex'))
  await page.goto('/')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const people = page.getByRole('region', { name: 'Find people' })
  await expect(people.getByRole('button', { name: 'Alice Cached' })).toBeVisible()
  testRelay.clear()
  await page.reload()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await people.getByRole('textbox', { name: 'Search people' }).fill('Alice')
  await expect(people.getByRole('button', { name: 'Alice Cached' })).toBeVisible()
})
