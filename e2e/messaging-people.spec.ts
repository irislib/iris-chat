import { test, expect } from './fixtures'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { AppKeys } from 'nostr-double-ratchet'
import { WebSocket } from 'ws'
import { SocialGraph } from 'nostr-social-graph'

const SIRIUS = '4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0'

test.beforeEach(async ({ page }) => {
  // The remote index has its own real-tree tests; keep these browser scenarios
  // deterministic while exercising cached discovery and the local relay.
  await page.route(/https:\/\/(cdn|upload|hashtree)\.iris\.to\//, route => route.abort())
})

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

for (const emptyHead of [false, true]) test(`discovers people without follows (${emptyHead ? 'empty list' : 'new account'})`, async ({ page, testRelayUrl }, testInfo) => {
  const local = generateSecretKey(), person = generateSecretKey()
  const owner = getPublicKey(person), time = Math.floor(Date.now() / 1000)
  const graph = new SocialGraph(SIRIUS)
  graph.addFollower(SIRIUS, owner)
  const seed = Buffer.from(await graph.toBinary())
  await page.route(/\/assets\/socialGraph-.*\.bin$/, route => route.fulfill({ body: seed, contentType: 'application/octet-stream' }))
  await publish(testRelayUrl, [
    ...(emptyHead ? [finalizeEvent({ kind: 3, created_at: time, tags: [], content: '' }, local)] : []),
    finalizeEvent({ kind: 0, created_at: time, tags: [], content: JSON.stringify({ name: 'Alice Discovery' }) }, person),
    finalizeEvent(new AppKeys([{ identityPubkey: getPublicKey(generateSecretKey()), createdAt: time }]).getEvent({
      ownerPrivateKey: person, ownerPubkey: owner, profileId: '123e4567-e89b-42d3-a456-426614174000', createdAt: time,
    }), person),
  ])
  await page.addInitScript(key => localStorage.setItem('iris-chat-identity', key), Buffer.from(local).toString('hex'))
  await page.goto('/')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const people = page.getByRole('region', { name: 'Find people' })
  const result = people.getByRole('button', { name: 'Alice Discovery' })
  await expect(result).toBeVisible({ timeout: 2500 })
  await people.getByRole('textbox', { name: 'Search people' }).fill('Alice')
  await expect(result).toBeVisible({ timeout: 500 })
  await page.screenshot({ path: testInfo.outputPath('no-follows-discovery.png'), fullPage: true })
  await result.click()
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
})

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

test('ranks people by social connections, hides overmuted users, and keeps deliberate ID lookup', async ({ page, testRelayUrl }, testInfo) => {
  const local = generateSecretKey()
  const friends = [generateSecretKey(), generateSecretKey(), generateSecretKey()]
  const peopleKeys = Array.from({ length: 6 }, () => generateSecretKey())
  const [direct, supported, distant, stranger, overmuted, blocked] = peopleKeys
  const names = ['Alice Zebra', 'Alice Beta', 'Alice Alpha', 'Alice Stranger', 'Alice Overmuted', 'Alice Blocked']
  const time = Math.floor(Date.now() / 1000)
  const list = (author: Uint8Array, kind: number, targets: Uint8Array[]) => finalizeEvent({
    kind, created_at: time, tags: targets.map(target => ['p', getPublicKey(target)]), content: '',
  }, author)
  await publish(testRelayUrl, [
    list(local, 3, [...friends, direct]), list(local, 10000, [blocked]),
    list(friends[0], 3, [supported, distant, overmuted]), list(friends[1], 3, [supported]),
    list(friends[1], 10000, [overmuted]), list(friends[2], 10000, [overmuted]),
    ...peopleKeys.flatMap((key, index) => [
      finalizeEvent({ kind: 0, created_at: time, tags: [], content: JSON.stringify({ name: names[index] }) }, key),
      finalizeEvent(new AppKeys([{ identityPubkey: getPublicKey(generateSecretKey()), createdAt: time }]).getEvent({
        ownerPrivateKey: key, ownerPubkey: getPublicKey(key), profileId: '123e4567-e89b-42d3-a456-426614174000', createdAt: time,
      }), key),
    ]),
  ])
  await page.addInitScript(key => localStorage.setItem('iris-chat-identity', key), Buffer.from(local).toString('hex'))
  await page.goto('/')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Create New Invite', exact: true })).toBeVisible()
  // A previously seen profile remains searchable even outside the current graph.
  await page.evaluate(async profiles => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('iris-chat')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('profiles', 'readwrite')
      for (const profile of profiles) transaction.objectStore('profiles').put({ ...profile, updatedAt: Date.now() })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
  }, [stranger, overmuted, blocked].map((key, index) => ({ pubkey: getPublicKey(key), name: names[index + 3] })))
  const people = page.getByRole('region', { name: 'Find people' })
  const search = people.getByRole('textbox', { name: 'Search people' })
  await search.fill('Alice')
  const rankedNames = [/^\s*Alice Zebra\s*$/, /^\s*Alice Beta\s*$/, /^\s*Alice Alpha\s*$/, /^\s*Alice Stranger\s*$/]
  await expect(people.getByRole('button')).toHaveText(rankedNames)
  await expect(people.getByRole('heading', { name: 'Find people' })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('people-social-ranking.png'), fullPage: true })
  await search.fill(nip19.npubEncode(getPublicKey(overmuted)))
  await expect(people.getByRole('button', { name: 'Alice Overmuted' })).toBeVisible()
  // A failed index must finish promptly and never pretend there are no people.
  await search.fill('NoSuchPersonForThisTest')
  await expect(people.getByText('Search is unavailable. Try again.', { exact: true })).toBeVisible({ timeout: 2000 })
  await search.fill('Alice')
  await expect(people.getByRole('button')).toHaveText(rankedNames)
  // The same filters and ordering survive cache restoration and a fresh query.
  await page.reload()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await search.fill('Alice')
  await expect(people.getByRole('button')).toHaveText(rankedNames)
})
