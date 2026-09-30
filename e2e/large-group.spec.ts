import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { test, expect } from './fixtures'
import { createGroupFarm } from './group-runtime-farm'
import { createParallelGroupFarm } from './parallel-group-runtime-farm'
import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { Session as NodeProfiler } from 'node:inspector/promises'

type Message = { id: string; content: string }
type DirectEnvelope = { id: string; author: string; recipients: string[]; deliveries: number }

async function messagesInBrowser(page: Page, groupId: string): Promise<Message[]> {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('iris-chat')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<Message[]>((resolve, reject) => {
        const request = db.transaction('messages').objectStore('messages').index('sessionId').getAll(`group:${id}`)
        request.onsuccess = () => resolve(request.result.map(({ id, content }) => ({ id, content })))
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
  }, groupId)
}

async function registerBrowserAdmin(page: Page, key: Uint8Array) {
  await page.context().addInitScript((secret) => {
    localStorage.setItem('iris-chat-identity', secret)
    localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [], stunServers: [] }))
  }, Buffer.from(key).toString('hex'))
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Devices', exact: true }).click()
  await page.getByRole('button', { name: 'Register this device' }).click()
  await expect(page.getByText('This device').first()).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('button', { name: 'Back' }).click()
}

const byId = (left: Message, right: Message) => left.id.localeCompare(right.id)
const scaleMessages = (messages: Message[]) => messages.filter((message) => message.content.startsWith('Scale message')).sort(byId)

async function browserDeviceCounts(page: Page, owners: string[], directEvents: DirectEnvelope[] = []) {
  return page.evaluate(async ({ owners, debugRuntime, directEvents }) => {
    let live: unknown
    if (debugRuntime) {
      // Optional Vite-dev diagnostic only; acceptance runs use the production build.
      const path = '/src/lib/privateChats.ts'
      const { getNdrRuntime } = await import(path)
      const runtime = getNdrRuntime()
      const manager = runtime.getSessionManager()
      const knownAuthors = new Set(manager.getAllMessagePushAuthorPubkeys())
      const { ownerPubkey, currentDevicePubkey } = runtime.getState()
      const eligible = directEvents.filter((event) => event.recipients.length === 0
        || event.recipients.includes(ownerPubkey) || event.recipients.includes(currentDevicePubkey))
      const pending = [...manager.pendingDirectMessages.values()] as Array<{ pubkey: string }>
      live = { subscriptions: runtime.sessionManagerEmittedSubscriptions.size,
        direct: { uniqueIds: eligible.length, deliveries: eligible.reduce((count, event) => count + event.deliveries, 0),
          distinctAuthors: new Set(eligible.map((event) => event.author)).size,
          knownAuthorEvents: eligible.filter((event) => knownAuthors.has(event.author)).length,
          pending: pending.length, pendingKnownAuthors: pending.filter((event) => knownAuthors.has(event.pubkey)).length },
        owners: owners.slice(0, 5).map((owner, index) => ({ owner: index,
          devices: [...(manager.getUserRecords().get(owner)?.devices.values() ?? [])].map((device: any) => ({
            state: device.state, active: !!device.activeSession, inactive: device.inactiveSessions.length, inviteSubscription: !!device.inviteSubscription,
          })) })) }
    }
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('iris-chat')
      request.onsuccess = () => resolve(request.result)
    })
    const rows = await new Promise<Array<{ key: string; value: any }>>((resolve) => {
      const request = db.transaction('sessionManager').objectStore('sessionManager').getAll()
      request.onsuccess = () => resolve(request.result)
    })
    const contacts = await new Promise<number>((resolve) => {
      const request = db.transaction('messages').objectStore('messages').getAll()
      request.onsuccess = () => resolve(request.result.filter((message) => /^Contact \d{3}$/.test(message.content)).length)
    })
    db.close()
    return { contacts, live, owners: owners.slice(0, 5).map((owner, index) => {
      const record = rows.find((row) => row.key === `v1/user/${owner}`)?.value
      return { owner: index, rosterDevices: record?.appKeys && JSON.parse(record.appKeys).devices.length,
        devices: record?.devices?.map((device: any) => ({ active: !!device.activeSession, inactive: device.inactiveSessions?.length,
          queued: rows.filter((row) => row.value?.targetKey === device.deviceId).map((row) => row.value.event?.kind) })) }
    }) }
  }, { owners, directEvents, debugRuntime: process.env.IRIS_GROUP_DEBUG_RUNTIME === '1' })
}

test('incoming invitations preserve group creation, settings and the current conversation', async ({ page, testRelay }) => {
  test.setTimeout(120_000)
  const key = generateSecretKey()
  const owner = getPublicKey(key)
  await registerBrowserAdmin(page, key)
  const peers = await createGroupFarm(5, testRelay.url)
  try {
    await page.getByRole('button', { name: 'New Chat' }).click()
    await peers[0]![0]!.sendContact(owner, 'First contact')
    // An explicit New Chat flow still opens the accepted invitation.
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
    await expect(page.getByText('First contact', { exact: true }).last()).toBeVisible()
    await page.getByRole('button', { name: 'Go to home' }).click()
    await page.getByRole('button', { name: 'Create Group' }).click()
    await peers[1]![0]!.sendContact(owner, 'Second contact')
    await expect(page.getByTestId('create-group-member')).toHaveCount(2)
    await page.getByTestId('create-group-member').first().click()
    await expect(page.getByTestId('create-group-next')).toHaveText('Next (1 selected)')

    await page.getByRole('button', { name: 'Settings' }).click()
    await peers[2]![0]!.sendContact(owner, 'Third contact')
    await expect(page.getByTestId('sidebar-chat-list').getByRole('button')).toHaveCount(3)
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()

    await page.getByRole('button', { name: 'Go to home' }).click()
    await peers[3]![0]!.sendContact(owner, 'Fourth contact')
    await expect(page.getByTestId('sidebar-chat-list').getByRole('button')).toHaveCount(4)
    await expect(page.getByRole('button', { name: 'Create Group' })).toBeVisible()

    await page.getByTestId('sidebar-chat-list').getByRole('button', { name: /First contact/ }).click()
    const composer = page.getByPlaceholder('Type a message...')
    await composer.fill('Keep this draft')
    await peers[4]![0]!.sendContact(owner, 'Fifth contact')
    await expect(page.getByTestId('sidebar-chat-list').getByRole('button')).toHaveCount(5)
    await expect(composer).toHaveValue('Keep this draft')
    await expect(page.getByText('First contact', { exact: true }).last()).toBeVisible()
  } finally {
    await Promise.all(peers.flat().map((peer) => peer.stop()))
  }
})

// Normal CI exercises the same path with four owners. Explicitly run
// IRIS_GROUP_MEMBERS=100 pnpm exec playwright test e2e/large-group.spec.ts --workers=1 --retries=0
// for the complete 101-owner, mixed-device delivery matrix.
test('browser admin creates a mixed-device group; all members exchange messages and recover offline', async ({ page, testRelay }) => {
  test.setTimeout(20 * 60_000)
  const memberCount = Number(process.env.IRIS_GROUP_MEMBERS || 4)
  const deliveryTimeout = Math.max(30_000, memberCount * 1_800)
  expect(memberCount).toBeGreaterThanOrEqual(2)
  expect(Number.isInteger(memberCount)).toBe(true)
  const key = generateSecretKey()
  const owner = getPublicKey(key)
  const started = performance.now()
  const browserInviteRequests = new Map<string, number>()
  const browserReceivedInvites = new Map<string, number>()
  const browserDirectEvents = new Map<string, DirectEnvelope>()
  let requestCount = 0
  page.on('websocket', (socket) => {
    if (socket.url().replace(/\/$/, '') !== testRelay.url) return
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString())
      const event = frame[0] === 'EVENT' ? frame[2] : undefined
      if (event?.kind === 30078) browserReceivedInvites.set(event.pubkey, (browserReceivedInvites.get(event.pubkey) ?? 0) + 1)
      if (event?.kind === 1060) {
        const previous = browserDirectEvents.get(event.id)
        browserDirectEvents.set(event.id, { id: event.id, author: event.pubkey,
          recipients: event.tags.filter((tag: string[]) => tag[0] === 'p').map((tag: string[]) => tag[1]), deliveries: (previous?.deliveries ?? 0) + 1 })
        if (browserDirectEvents.size > 4096) browserDirectEvents.delete(browserDirectEvents.keys().next().value!)
      }
    })
  })
  testRelay.observeRequest = (filters, browser) => {
    requestCount++
    if (!browser) return
    for (const filter of filters) if (filter.kinds?.includes(30078)) {
      for (const author of filter.authors ?? []) browserInviteRequests.set(author, (browserInviteRequests.get(author) ?? 0) + 1)
    }
  }
  await registerBrowserAdmin(page, key)
  console.log('Browser admin registered')

  const farm = await createParallelGroupFarm(memberCount, testRelay.url)
  try {
    const { owners, shardSize } = farm
    const devices = owners.flat()
    const expectedMembers = [owner, ...owners.map((peers) => peers[0]!.owner)].sort()
    const offline = owners[0]!.at(-1)!
    const onlineDevices = devices.filter((device) => device !== offline)
    // One already linked device misses both the group invitation and first keys.
    await offline.stop()
    console.log(`Farm ready: ${owners.length} owners, ${devices.length} devices`)
    let completed = false
    const profiler = process.env.IRIS_GROUP_PROFILE === '1' ? await page.context().newCDPSession(page) : undefined
    await profiler?.send('Profiler.enable')
    await profiler?.send('Profiler.start')
    const nodeProfiler = profiler ? new NodeProfiler() : undefined
    nodeProfiler?.connect()
    await nodeProfiler?.post('Profiler.enable')
    await nodeProfiler?.post('Profiler.start')
    const progress = setInterval(() => console.log('Group progress', JSON.stringify({
      groupRecipients: onlineDevices.filter((device) => device.groups.size === 1).length,
      devicesByMessageCount: Object.fromEntries([...new Set(onlineDevices.map((device) => device.messages.size))]
        .sort((left, right) => left - right).map((count) => [count, onlineDevices.filter((device) => device.messages.size === count).length])),
      requests: requestCount, relayEvents: testRelay.publishedEvents.length, deliveries: testRelay.deliveredEvents,
      replayedEvents: testRelay.replayedEvents, liveEvents: testRelay.liveEvents,
    })), 15_000)
    try {
      const contactSetupStarted = performance.now()
      for (let offset = 0; offset < owners.length; offset += 5) {
        await test.step(`Contact bootstrap ${offset + 1}–${Math.min(offset + 5, memberCount)}`, () =>
          Promise.all(owners.slice(offset, offset + 5).map((peers, index) =>
            peers[0]!.sendContact(owner, `Contact ${String(offset + index).padStart(3, '0')}`))), { timeout: 60_000 })
      }
      await expect(page.getByTestId('sidebar-chat-list').getByRole('button')).toHaveCount(memberCount, { timeout: 90_000 })
      const contactSetupMs = Math.round(performance.now() - contactSetupStarted)
      console.log(`All ${memberCount} contacts visible (${contactSetupMs} ms)`)
      expect(owners.every((peers) => peers.every((peer) => peer === offline || peer.getState().registeredDevices.length === peers.length))).toBe(true)
      console.log('Browser rosters before group creation', JSON.stringify(await browserDeviceCounts(page, owners.map((peers) => peers[0]!.owner), [...browserDirectEvents.values()])))
      await page.getByRole('button', { name: 'Go to home' }).click()
      await page.getByRole('button', { name: 'Create Group' }).click()
      const candidates = page.getByTestId('create-group-member')
      await expect(candidates).toHaveCount(memberCount, { timeout: 90_000 })
      for (let index = 0; index < memberCount; index++) await candidates.nth(index).click()
      await page.getByTestId('create-group-next').click()
      await page.getByPlaceholder('Enter group name...').fill('Group reliability test')
      const groupCreateStarted = performance.now()
      await page.getByTestId('create-group-submit').click()
      console.log('Group creation submitted')
      const composer = page.getByPlaceholder('Type a message...')
      await expect(composer).toBeVisible({ timeout: 90_000 })
      console.log('Group conversation opened')
      await expect.poll(() => onlineDevices.filter((device) => device.groups.size === 1).length, { timeout: 90_000 }).toBe(onlineDevices.length)
      const groupId = [...devices[0]!.groups.keys()][0]!
      for (const [index, device] of onlineDevices.entries()) {
        expect([...device.groups.get(groupId)!.members].sort(), `Members on device ${index}`).toEqual(expectedMembers)
      }
      const setupMs = Math.round(performance.now() - started)
      const groupCreationMs = Math.round(performance.now() - groupCreateStarted)
      console.log(`Group membership received on all online devices (${groupCreationMs} ms; including fixture setup ${setupMs} ms)`)

      await composer.fill('Scale message from browser admin')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await page.evaluate(() => {
        const samples: number[] = []
        const frameGaps: number[] = []
        let lastFrame = performance.now()
        let stopped = false
        let keystroke = 0
        const frame = (now: number) => {
          frameGaps.push(now - lastFrame)
          lastFrame = now
          if (!stopped) requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
        const timer = setInterval(() => {
          const composer = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Type a message..."]')
          if (!composer) return
          const started = performance.now()
          // Exercise the same Svelte input/draft handlers while the test driver's
          // separate process is busy signing and decrypting the simulated peers.
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
          setter.call(composer, `Typing while messages arrive ${++keystroke}`)
          composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'e' }))
          requestAnimationFrame(() => samples.push(performance.now() - started))
        }, 100)
        ;(window as any).finishGroupResponsiveness = () => {
          stopped = true
          clearInterval(timer)
          return { samples, frameGaps }
        }
      })
      const contents = owners.map((_, index) => `Scale message from member ${String(index).padStart(3, '0')}`)
      // Spread concurrent writers across the worker shards while keeping
      // each owner's linked devices together in one shard.
      const writerOrder = Array.from({ length: shardSize }, (_, offset) =>
        Array.from({ length: Math.ceil(memberCount / shardSize) }, (_, shard) => offset + shard * shardSize)
      ).flat().filter((index) => index < memberCount)
      const sentMessages: Message[] = []
      const burstStarted = performance.now()
      await test.step('Every member sends through its own runtime', async () => {
        // Small overlapping bursts model several people writing together.
        for (let offset = 0; offset < owners.length; offset += 5) {
          const burst = await Promise.all(writerOrder.slice(offset, offset + 5).map((index) => owners[index]![0]!.send(groupId, contents[index]!)))
          sentMessages.push(...burst)
          // Sending may return after durably queueing keys. Wait for delivery so
          // the next burst doesn't accidentally turn into 100 simultaneous writers.
          await expect.poll(() => onlineDevices.every((device) =>
            burst.every(({ id, content }) => device.messages.get(id) === content)
          ), { timeout: deliveryTimeout }).toBe(true)
        }
      })
      console.log('All member sends completed')
      await expect.poll(async () => (await messagesInBrowser(page, groupId)).find((message) => message.content === 'Scale message from browser admin')?.id).toMatch(/^[0-9a-f]{64}$/)
      const adminMessage = (await messagesInBrowser(page, groupId)).find((message) => message.content === 'Scale message from browser admin')!
      const expected = [adminMessage, ...sentMessages].sort(byId)
      await expect.poll(() => onlineDevices.map((device, index) => ({
        device: index,
        count: [...device.messages.values()].filter((content) => content.startsWith('Scale message')).length,
        missing: expected.filter(({ id, content }) => device.messages.get(id) !== content).map((message) => message.id),
      })).filter((device) => device.missing.length || device.count !== expected.length).slice(0, 5), { timeout: deliveryTimeout }).toEqual([])
      await expect.poll(async () => scaleMessages(await messagesInBrowser(page, groupId)), { timeout: 90_000 }).toEqual(expected)
      const exchangeMs = Math.round(performance.now() - burstStarted)
      const responsiveness = await page.evaluate(() => (window as any).finishGroupResponsiveness()) as { samples: number[]; frameGaps: number[] }
      await expect(composer).toHaveValue(/^Typing while messages arrive \d+$/)
      expect(responsiveness.samples.length).toBeGreaterThan(0)
      expect(Math.max(...responsiveness.samples)).toBeLessThan(3_000)
      expect(Math.max(...responsiveness.frameGaps)).toBeLessThan(3_000)
      expect(devices.flatMap((device) => device.failures)).toEqual([])
      const timings = { owners: memberCount + 1, devices: devices.length + 1, setupMs, contactSetupMs, groupCreationMs, exchangeMs,
        inputMaxMs: Math.round(Math.max(...responsiveness.samples)), frameGapMaxMs: Math.round(Math.max(...responsiveness.frameGaps)), inputSamples: responsiveness.samples.length }
      console.log('Online delivery matrix verified', JSON.stringify({ ...timings, exactIdBodyDeliveries: expected.length * (onlineDevices.length + 1) }))

      await offline.start()
      await expect.poll(() => scaleMessages([...offline.messages].map(([id, content]) => ({ id, content }))), { timeout: 90_000 }).toEqual(expected)
      expect([...offline.groups.get(groupId)!.members].sort()).toEqual(expectedMembers)

      // A linked device leaves after the first exchange, then restores its own
      // persisted ratchet state and catches up from the relay, without duplicates.
      await offline.stop()
      await owners[1]![0]!.send(groupId, 'Message while one linked device is offline')
      await offline.start()
      await expect.poll(() => [...offline.messages.values()].filter((text) => text === 'Message while one linked device is offline').length, { timeout: 60_000 }).toBe(1)
      const reply = await offline.send(groupId, 'Reply from the recovered linked device')
      await expect.poll(() => onlineDevices.every((device) => device.messages.get(reply.id) === reply.content), { timeout: 60_000 }).toBe(true)
      await expect.poll(async () => (await messagesInBrowser(page, groupId)).find((message) => message.id === reply.id)?.content).toBe(reply.content)
      await page.reload()
      await expect.poll(async () => scaleMessages(await messagesInBrowser(page, groupId))).toEqual(expected)
      await page.getByTestId('sidebar-chat-list').getByRole('button', { name: /Group reliability test/ }).click()
      await expect(composer).toBeVisible()
      await page.screenshot({ path: `work/large-group-${memberCount}.png` })
      expect(devices.flatMap((device) => device.failures)).toEqual([])
      console.log(JSON.stringify({ ...timings, allDeviceDeliveries: expected.length * (devices.length + 1), peerStorageReads: devices.reduce((sum, device) => sum + device.storage.reads, 0), relayEvents: testRelay.publishedEvents.length }))
      completed = true
    } finally {
      clearInterval(progress)
      if (profiler) {
        const { profile } = await profiler.send('Profiler.stop')
        mkdirSync('work', { recursive: true })
        writeFileSync(`work/large-group-${memberCount}.cpuprofile`, JSON.stringify(profile))
        await profiler.detach()
      }
      if (nodeProfiler) {
        const { profile } = await nodeProfiler.post('Profiler.stop')
        writeFileSync(`work/large-group-${memberCount}-worker.cpuprofile`, JSON.stringify(profile))
        nodeProfiler.disconnect()
      }
      try {
        if (!completed) console.log('Group diagnostics', JSON.stringify({
          browser: await browserDeviceCounts(page, owners.map((peers) => peers[0]!.owner), [...browserDirectEvents.values()]),
          recoveredToSiblings: await Promise.all(owners[0]!.filter((peer) => peer !== offline).map((peer) => offline.directHandoffDiagnostics(peer))),
          queues: await Promise.all([...onlineDevices.slice(0, 5), offline].map(async (device, index) => {
            return { device: index === 5 ? 'recovered' : index, ...await device.diagnostics(),
              recoveredKeyHandoffs: [...device.receivedKeyHandoffs.values()].filter((sender) => sender === offline.getState().currentDevicePubkey).length }
          })),
          farm: owners.slice(0, 5).map((peers, owner) => ({ owner, devices: peers.map((peer) => ({ registered: peer.getState().registeredDevices.length, groups: peer.groups.size })) })),
          inviteRequests: owners.slice(0, 5).map((peers) => peers.map((peer) => ({
            requests: browserInviteRequests.get(peer.getState().currentDevicePubkey!) ?? 0,
            received: browserReceivedInvites.get(peer.getState().currentDevicePubkey!) ?? 0,
            published: testRelay.publishedEvents.filter((event) => event.kind === 30078 && event.pubkey === peer.getState().currentDevicePubkey).length,
          }))),
        }))
      } catch (error) { console.log('Group diagnostics unavailable', String(error)) }
    }
  } finally {
    await farm.close()
    testRelay.observeRequest = undefined
  }
})
