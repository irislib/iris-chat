import type { BrowserContext, TestInfo } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

export async function observeCallMedia(context: BrowserContext) {
  await context.addInitScript(() => {
    const captures: Array<{ at: number; stream: MediaStream; tracks: MediaStreamTrack[] }> = []
    const contexts: Array<{ context: AudioContext; changes: Array<{ at: number; state: string; time: number }> }> = []
    const worklets: Array<Record<string, number | string>> = []
    const captureErrors: string[] = []
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async constraints => {
      try {
        const stream = await getUserMedia(constraints)
        captures.push({ at: performance.now(), stream, tracks: stream.getTracks() })
        if (captures.length > 16) captures.shift()
        return stream
      } catch (error) {
        captureErrors.push(String(error).slice(0, 240)); if (captureErrors.length > 8) captureErrors.shift()
        throw error
      }
    }
    // Forward construction and preserve prototypes, including the call test's
    // existing oscillator tracking. Observe ports without replacing handlers.
    window.AudioContext = new Proxy(window.AudioContext, {
      construct(target, args, newTarget) {
        const context = Reflect.construct(target, args, newTarget) as AudioContext
        const changes = [{ at: performance.now(), state: context.state, time: context.currentTime }]
        context.addEventListener('statechange', () => {
          changes.push({ at: performance.now(), state: context.state, time: context.currentTime })
          if (changes.length > 16) changes.shift()
        })
        contexts.push({ context, changes }); if (contexts.length > 8) contexts.shift()
        return context
      },
    })
    window.AudioWorkletNode = new Proxy(window.AudioWorkletNode, {
      construct(target, args, newTarget) {
        const node = Reflect.construct(target, args, newTarget) as AudioWorkletNode
        const context = args[0] as BaseAudioContext
        const stats = { name: String(args[1]), captured: 0, playout: 0, staleCapture: 0, stalePlayout: 0,
          captureAgeMs: 0, playoutAgeMs: 0, lastCaptureAt: 0, lastPlayoutAt: 0, processorErrors: 0 }
        node.addEventListener('processorerror', () => { stats.processorErrors++ })
        node.port.addEventListener('message', event => {
          if (typeof event.data?.capturedAt === 'number') {
            stats.captured++; stats.lastCaptureAt = performance.now()
            stats.captureAgeMs = Math.max(0, (context.currentTime - event.data.capturedAt) * 1000)
            if (stats.captureAgeMs > 100) stats.staleCapture++
          }
          if (typeof event.data?.playout === 'number') {
            stats.playout++; stats.lastPlayoutAt = performance.now()
            stats.playoutAgeMs = Math.max(0, (context.currentTime - event.data.playout) * 1000)
            if (stats.playoutAgeMs >= 100) stats.stalePlayout++
          }
        })
        worklets.push(stats); if (worklets.length > 8) worklets.shift()
        return node
      },
    })
    Object.assign(window, { irisCallMediaDiagnostics: () => ({
      at: performance.now(), visibility: document.visibilityState, captureErrors, worklets,
      call: { ...document.querySelector<HTMLElement>('[data-testid="call-screen"]')?.dataset },
      captures: captures.map(({ at, stream, tracks }) => ({ at, active: stream.active,
        tracks: tracks.map(track => {
          const { deviceId: _deviceId, groupId: _groupId, ...settings } = track.getSettings()
          return { kind: track.kind, readyState: track.readyState, enabled: track.enabled, muted: track.muted, settings }
        }),
      })),
      contexts: contexts.map(({ context, changes }) => ({ state: context.state, time: context.currentTime, changes })),
    }) })
  })
}

export async function writeCallMediaDiagnostics(contexts: BrowserContext[], logs: string[], testInfo: TestInfo) {
  const pages = await Promise.all(contexts.flatMap(context => context.pages()).map(async (page, index) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const snapshot = await Promise.race([
        page.evaluate(() => (window as Window & { irisCallMediaDiagnostics?: () => unknown }).irisCallMediaDiagnostics?.()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Media snapshot timed out')), 2000) }),
      ])
      return { index, snapshot }
    } catch (error) { return { index, error: String(error).slice(0, 240) } }
    finally { clearTimeout(timer) }
  }))
  await mkdir(testInfo.outputDir, { recursive: true })
  await Promise.all([
    writeFile(testInfo.outputPath('call-media.json'), JSON.stringify({ at: new Date().toISOString(), retry: testInfo.retry, pages }, null, 2)),
    writeFile(testInfo.outputPath('browser.log'), logs.join('\n')),
  ])
}
