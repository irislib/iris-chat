import { test, expect } from '@playwright/test'
import { WebSocket, type RawData } from 'ws'
import { TestRelay, SilentTestRelay } from './test-relay'

type Frame = unknown[]
type Filter = Record<string, unknown>

for (const Relay of [TestRelay, SilentTestRelay]) {
  test(`${Relay.name} stops even when a client cannot acknowledge closing`, async () => {
    const relay = new Relay()
    await relay.start()
    const socket = new WebSocket(relay.url)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.pause()
    let stopped = false
    const stopping = relay.stop().then(() => { stopped = true })
    try {
      await expect.poll(() => stopped, { timeout: 1_000 }).toBe(true)
    } finally {
      socket.terminate()
      await stopping
    }
  })
}

function command(socket: WebSocket, frame: Frame, done: (frame: Frame) => boolean): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const received: Frame[] = []
    const cleanup = () => { clearTimeout(timer); socket.off('message', onMessage); socket.off('error', onError) }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onMessage = (data: RawData) => {
      const response = JSON.parse(data.toString()) as Frame
      received.push(response)
      if (done(response)) { cleanup(); resolve(received) }
    }
    const timer = setTimeout(() => onError(new Error(`Relay command ${frame[0]} timed out`)), 5_000)
    socket.on('message', onMessage)
    socket.on('error', onError)
    socket.send(JSON.stringify(frame))
  })
}

test('relay history indexes preserve filtering, order, replacements and live duplicates', async () => {
  const relay = new TestRelay()
  await relay.start()
  const socket = new WebSocket(relay.url)
  const frames: Frame[] = []
  socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as Frame))
  let sequence = 0
  const event = (id: string, pubkey: string, recipients: string[], kind: number, created_at: number, room: string) => ({
    id, pubkey, tags: [...recipients.map((recipient) => ['p', recipient]), ['room', room]],
    kind, created_at, content: id, sig: 'fixture',
  })
  type Event = ReturnType<typeof event>
  const publish = async (value: Event) => {
    const replies = await command(socket, ['EVENT', value], (frame) => frame[0] === 'OK' && frame[1] === value.id)
    expect(replies.at(-1)).toEqual(['OK', value.id, true, ''])
  }
  const query = async (filters: Filter[], subscription = `query-${++sequence}`, keep = false) => {
    const replies = await command(socket, ['REQ', subscription, ...filters], (frame) => frame[0] === 'EOSE' && frame[1] === subscription)
    if (!keep) await command(socket, ['CLOSE', subscription], (frame) => frame[0] === 'CLOSED' && frame[1] === subscription)
    return replies.filter((frame) => frame[0] === 'EVENT' && frame[1] === subscription).map((frame) => frame[2] as Event)
  }
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const first = event('first', 'alice', ['carol'], 1, 10, 'red')
    const second = event('second', 'bob', ['carol'], 2, 20, 'blue')
    const third = event('third', 'alice', ['dave', 'carol'], 1, 30, 'red')
    const fourth = event('fourth', 'eve', ['dave'], 1, 40, 'blue')
    const insertionOrder = [third, first, fourth, second]
    for (const value of insertionOrder) await publish(value)

    expect(await query([{ authors: ['alice'], '#p': ['dave'], ids: ['first', 'third'] }])).toEqual([third])
    expect(await query([{ authors: ['alice'], '#p': ['dave'], ids: ['first'] }])).toEqual([])
    expect(await query([{ authors: ['bob', 'alice'] }, { '#p': ['dave'] }])).toEqual(insertionOrder)
    expect(await query([{ ids: ['second', 'third', 'missing'] }, { '#p': ['carol'] }])).toEqual([third, first, second])
    expect(await query([{ kinds: [1], since: 15, until: 35, '#room': ['red'] }])).toEqual([third])
    expect(await query([{ authors: ['alice'], kinds: [1], since: 15, until: 35, '#room': ['red'] }])).toEqual([third])
    expect(await query([{ authors: ['bob'] }, { '#room': ['red'] }])).toEqual([third, first, second])
    // The fixture has always ignored limit; indexing must not change that.
    expect(await query([{ limit: 1 }])).toEqual(insertionOrder)
    expect(await query([])).toEqual([])
    for (const key of ['authors', '#p', 'ids']) expect(await query([{ [key]: [] }])).toEqual([])
    expect(await query([{ authors: [] }, { kinds: [2] }])).toEqual([second])

    await query([{}], 'live', true)
    frames.length = 0
    // This deliberately unsigned fixture permits changed fields under the same
    // ID. Its original insertion position and every live publication survive.
    const replacement = { ...first, pubkey: 'bob', tags: [['p', 'dave'], ['room', 'green']], content: 'replacement' }
    await publish(replacement)
    await publish(replacement)
    expect(await query([{}])).toEqual([third, replacement, fourth, second])
    expect(frames.filter((frame) => frame[0] === 'EVENT' && frame[1] === 'live').map((frame) => frame[2])).toEqual([replacement, replacement])
    expect(await query([{ authors: ['alice'] }])).toEqual([third])
    expect(await query([{ authors: ['bob'] }])).toEqual([replacement, second])
    expect(await query([{ '#p': ['carol'] }])).toEqual([third, second])
    expect(await query([{ '#p': ['dave'] }])).toEqual([third, replacement, fourth])

    relay.deliveryFilter = (value) => value.id !== first.id
    frames.length = 0
    await publish(replacement)
    expect(await query([{ authors: ['bob'] }])).toEqual([second])
    expect(await query([{}])).toEqual([third, fourth, second])
    expect(frames.filter((frame) => frame[0] === 'EVENT' && frame[1] === 'live')).toEqual([])
    relay.deliveryFilter = undefined

    relay.clear()
    for (const filter of [{}, { authors: ['bob'] }, { '#p': ['dave'] }, { ids: ['first'] }]) {
      expect(await query([filter])).toEqual([])
    }
    await publish(second)
    await publish(first)
    expect(await query([{}])).toEqual([second, first])
    expect(await query([{ '#p': ['carol'] }])).toEqual([second, first])
  } finally {
    socket.terminate()
    await relay.stop()
  }
})
