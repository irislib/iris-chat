import { test, expect } from './fixtures'
import { AppKeys } from 'nostr-double-ratchet'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { WebSocket } from 'ws'

test('a verified device removal runs normal logout and clears local private data', async ({ page, testRelay, testRelayUrl }) => {
  // This profile and relay exist only for this test.
  await page.goto('/')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Devices', exact: true }).click()
  const register = page.getByRole('button', { name: 'Register this device' })
  await expect(async () => {
    if (await register.isVisible()) await register.click()
    await expect(page.getByText('This device', { exact: true }).first()).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 30000 })
  const secret = Uint8Array.from(Buffer.from((await page.evaluate(() => localStorage.getItem('iris-chat-identity')))! , 'hex'))
  const owner = getPublicKey(secret)
  const registered = testRelay.publishedEvents.filter(event => event.kind === 37368 && event.pubkey === owner)
    .sort((a, b) => b.created_at - a.created_at)[0]
  expect(registered).toBeDefined()
  const removed = new AppKeys([])
  const sign = (createdAt: number) => finalizeEvent(removed.getEvent({ ownerPubkey: owner, createdAt }), secret)
  const socket = new WebSocket(testRelayUrl)
  await new Promise<void>(resolve => socket.once('open', resolve))
  const publish = (event: ReturnType<typeof sign>) => new Promise<void>(resolve => {
    const received = (data: WebSocket.RawData) => {
      const packet = JSON.parse(data.toString())
      if (packet[0] === 'OK' && packet[1] === event.id) { socket.off('message', received); resolve() }
    }
    socket.on('message', received)
    socket.send(JSON.stringify(['EVENT', event]))
  })
  try {
    await publish(sign(registered.created_at - 1))
    const forged = sign(registered.created_at + 1)
    forged.content = 'tampered'
    await publish(forged)
    await expect(page.getByText('This device', { exact: true }).first()).toBeVisible()
    await publish(sign(registered.created_at + 2))
    await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
    await expect(page.getByRole('status')).toHaveText('This device was removed. Its local data has been cleared.')
    expect(await page.evaluate(() => localStorage.getItem('iris-chat-identity'))).toBeNull()
    const counts = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('iris-chat'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      const results = await Promise.all(['sessions', 'messages', 'groups', 'sessionManager', 'pendingPushEvents'].map(name => new Promise<number>((resolve, reject) => {
        const request = database.transaction(name).objectStore(name).count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })))
      database.close(); return results
    })
    expect(counts).toEqual([0, 0, 0, 0, 0])
    await page.screenshot({ path: 'work/device-removal.png' })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
  } finally { socket.close() }
})
