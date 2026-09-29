import { describe, expect, it, vi } from 'vitest'
import { createMediaCaptureLease } from './mediaCaptureLease'

function fixture() {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  return { stream, stop }
}

describe('voice capture lifetime', () => {
  it('stops permission results arriving after the recording UI was canceled', async () => {
    const { stream, stop } = fixture()
    let resolve!: (stream: MediaStream) => void
    const pending = new Promise<MediaStream>(done => { resolve = done })
    const lease = createMediaCaptureLease()
    const acquiring = lease.acquire(() => pending)
    lease.close()
    resolve(stream)
    expect(await acquiring).toBeNull()
    expect(stop).toHaveBeenCalledOnce()
    expect(lease.active).toBe(false)
  })

  it('releases capture even when MediaRecorder construction/start failed', async () => {
    const { stream, stop } = fixture()
    const lease = createMediaCaptureLease()
    expect(await lease.acquire(async () => stream)).toBe(stream)
    lease.close()
    lease.close()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('does not request permission after disposal or revive after rejection', async () => {
    const lease = createMediaCaptureLease()
    let reject!: (error: Error) => void
    const pending = new Promise<MediaStream>((_, fail) => { reject = fail })
    const acquiring = lease.acquire(() => pending)
    lease.close()
    reject(new Error('permission denied'))
    await expect(acquiring).rejects.toThrow('permission denied')
    const request = vi.fn()
    expect(await lease.acquire(request)).toBeNull()
    expect(request).not.toHaveBeenCalled()
    expect(lease.active).toBe(false)
  })
})
