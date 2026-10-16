import { expect, it } from 'vitest'
import { attachmentEndpoint } from './attachmentEndpoint'
it('bounds a hanging provider without starving another and cancels work queued at teardown', async () => {
  let hung = 0, served = 0
  const pending: (() => void)[] = []
  const { endpoint, close } = attachmentEndpoint({ registerService: () => () => {}, sendDatagram: args => {
    if (args.dst === 'dead') { hung++; return new Promise<void>(resolve => pending.push(resolve)) }
    served++; return Promise.resolve()
  } })
  const send = (dst: string) => endpoint.sendDatagram({ dst, dstPort: 1, payload: new Uint8Array(1024) })
  await Promise.all(Array.from({ length: 1000 }, () => send('dead')))
  await send('live'); await new Promise(resolve => setTimeout(resolve, 0))
  expect(hung).toBe(32); expect(served).toBe(1)
  pending.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 0))
  await send('dead'); expect(hung).toBe(33)
  const queued = send('live'); close(); await queued
  await new Promise(resolve => setTimeout(resolve, 0)); expect(served).toBe(1)
  pending.forEach(resolve => resolve())
  await send('live'); expect(served).toBe(1)
})
