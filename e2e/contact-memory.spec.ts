import { test, expect } from './fixtures'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { WebSocket } from 'ws'
import { SocialGraph } from 'nostr-social-graph'
import { mkdir } from 'node:fs/promises'

async function publish(url: string, events: ReturnType<typeof finalizeEvent>[]) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Set(events.map(event => event.id))
    const timer = setTimeout(() => { socket.close(); reject(new Error('Test publishing timed out')) }, 5000)
    socket.on('error', reject)
    socket.on('open', () => events.forEach(event => socket.send(JSON.stringify(['EVENT', event]))))
    socket.on('message', data => {
      const message = JSON.parse(String(data))
      if (message[0] !== 'OK') return
      pending.delete(message[1])
      if (!pending.size) { clearTimeout(timer); socket.close(); resolve() }
    })
  })
}

test('private contact memory, public follows and network warnings stay separate', async ({ page, testRelayUrl, testRelay }) => {
  test.setTimeout(90000)
  const local = generateSecretKey(), peer = generateSecretKey()
  const friend = generateSecretKey(), muter1 = generateSecretKey(), muter2 = generateSecretKey()
  const account = getPublicKey(local), person = getPublicKey(peer)
  const time = Math.floor(Date.now() / 1000) - 100
  const event = (secret: Uint8Array, kind: number, tags: string[][], content = '', offset = 0) => finalizeEvent({kind, created_at: time + offset, tags, content}, secret)
  const metadata = (name: string, offset: number) => event(peer, 0, [], JSON.stringify({name}), offset)
  const originalTags = [
    ['p', getPublicKey(friend), 'wss://example.com', 'friend'],
    ['p', getPublicKey(muter1)], ['p', getPublicKey(muter2)], ['x', 'keep-this-extension'],
  ]
  await publish(testRelayUrl, [
    metadata('Alice Original', 0),
    event(local, 3, originalTags, '{"existing":"content"}'),
    event(friend, 3, [['p', person]]),
    event(muter1, 10000, [['p', person]]), event(muter2, 10000, [['p', person]]),
  ])
  const seed = Buffer.from(await new SocialGraph(account).toBinary())
  await page.route(/\/assets\/socialGraph-.*\.bin$/, route => route.fulfill({ body: seed, contentType: 'application/octet-stream' }))
  await page.route(/https:\/\/(cdn|upload|hashtree)\.iris\.to\//, route => route.abort())
  await page.addInitScript(secret => localStorage.setItem('iris-chat-identity', secret), Buffer.from(local).toString('hex'))
  await page.goto(`/#profile-${person}`)
  await expect(page.getByRole('heading', { name: 'Alice Original', exact: true })).toBeVisible()
  const avatar = page.getByTestId('profile-avatar')
  await expect(avatar.getByLabel('More mutes than follows in your network')).toBeVisible()
  const memory = () => page.evaluate(({ account, person }) => JSON.parse(localStorage.getItem(`iris-contact-memory:v1:${account}:${person}`) || 'null'), { account, person })
  expect(await memory()).toBeNull()
  await page.getByRole('button', { name: 'Start Chat', exact: true }).click()
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
  await expect.poll(async () => (await memory())?.first_seen_name).toBe('Alice Original')
  await publish(testRelayUrl, [metadata('Alicia Updated', 10)])
  await expect(page.getByTestId('contact-name-change')).toContainText('Alice Original now goes by Alicia Updated.')
  await page.getByTestId('contact-name-change').getByRole('button', { name: 'Use this name' }).click()
  await expect(page.getByTestId('contact-name-history')).toContainText('Alice Original → Alicia Updated')
  await page.setViewportSize({width: 390, height: 844})
  await mkdir('work/contact-memory', {recursive: true})
  await page.screenshot({path: 'work/contact-memory/chat-approved-mobile.png', fullPage: true})
  await page.goto(`/#profile-${person}`)
  await expect(page.getByRole('heading', {name: 'Alicia Updated', exact: true})).toBeVisible()
  await page.getByRole('button', {name: 'Favorite', exact: true}).click()
  await expect(page.getByRole('button', {name: 'Favorited', exact: true})).toHaveAttribute('aria-pressed', 'true')
  await expect(avatar.getByLabel('More mutes than follows in your network')).toBeVisible()
  expect(testRelay.publishedEvents.filter(item => item.pubkey === account && item.kind === 3)).toHaveLength(1)
  await publish(testRelayUrl, [metadata('Alice Again', 20)])
  await expect(page.getByText('New name:', {exact: false})).toContainText('Alice Again')
  await expect(page.getByRole('heading', {name: 'Alicia Updated', exact: true})).toBeVisible()
  await page.screenshot({path: 'work/contact-memory/profile-warning-mobile.png', fullPage: true})
  await page.getByRole('button', {name: 'Use this name', exact: true}).click()
  await expect(page.getByRole('heading', {name: 'Alice Again', exact: true})).toBeVisible()
  await expect(page.getByText('First known as Alice Original')).toBeVisible()
  await page.getByRole('button', {name: 'Follow (public)', exact: true}).click()
  await expect(avatar.getByLabel('Following', {exact: true})).toBeVisible()
  const graphBadge = avatar.getByLabel('Following', {exact: true})
  await expect(graphBadge).toHaveCSS('background-color', 'rgb(10, 132, 255)')
  const badgeBounds = await graphBadge.boundingBox()
  const avatarBounds = await avatar.locator('img').boundingBox()
  expect(badgeBounds && avatarBounds).toBeTruthy()
  expect(badgeBounds!.y + badgeBounds!.height / 2).toBeLessThan(avatarBounds!.y + avatarBounds!.height / 2)
  expect(badgeBounds!.x + badgeBounds!.width / 2).toBeGreaterThan(avatarBounds!.x + avatarBounds!.width / 2)
  const followHead = testRelay.publishedEvents.filter(item => item.pubkey === account && item.kind === 3).sort((a,b) => b.created_at - a.created_at)[0]
  expect(followHead.tags).toEqual([...originalTags, ['p', person]])
  expect(followHead.content).toBe('{"existing":"content"}')
  await page.getByRole('button', {name: 'Unfollow (public)', exact: true}).click()
  await expect(avatar.getByLabel('More mutes than follows in your network')).toBeVisible()
  await publish(testRelayUrl, [event(local, 10000, [['p', person]], '', 30)])
  await expect(avatar.getByLabel('Muted', {exact: true})).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', {name: 'Alice Again', exact: true})).toBeVisible()
  expect((await memory()).name_changes).toHaveLength(2)
  expect((await memory()).favorite).toBe(true)
  await page.getByRole('button', {name: 'Open Chat', exact: true}).click()
  await expect(page.getByTestId('contact-name-history')).toHaveCount(2)
  expect(testRelay.publishedEvents.filter(item => item.pubkey === account).every(item => !item.content.includes('Alice Original') && !item.content.includes('Alicia Updated'))).toBe(true)
})
