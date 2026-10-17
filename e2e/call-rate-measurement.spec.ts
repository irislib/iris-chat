import { test, expect } from '@playwright/test'
import { measureCallRates } from './fixtures/callRateMeasurement'

test('call rates use fresh browser reports despite stale UI and driver delay', async ({ page }) => {
  await page.setContent('<div data-testid="call-screen" data-video-frames="0" data-audio-frames="0" data-sent-bytes="0"></div>')
  const measurement = measureCallRates(page, 300, 2000)
  // The old counters intentionally sit unchanged before the first fresh report.
  // Counting this delay would understate every rate, as would driver roundtrips.
  await page.evaluate(async () => {
    const element = document.querySelector('[data-testid="call-screen"]')!
    await new Promise(resolve => setTimeout(resolve, 400))
    const start = performance.now()
    for (let i = 0; i < 6; i++) {
      const seconds = (performance.now() - start) / 1000
      element.setAttribute('data-video-frames', String(100 + seconds * 10))
      element.setAttribute('data-audio-frames', String(500 + seconds * 50))
      element.setAttribute('data-sent-bytes', String(10000 + seconds * 20000))
      await new Promise(resolve => setTimeout(resolve, i % 2 ? 110 : 90))
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  })
  const result = await measurement
  expect(result.start.video).toBeGreaterThanOrEqual(100)
  expect(result.seconds).toBeGreaterThanOrEqual(.3)
  expect(result.decodedFps).toBeCloseTo(10, 0)
  expect(result.audioFps).toBeCloseTo(50, 0)
  expect(result.payloadBps).toBeGreaterThan(150000)
  expect(result.payloadBps).toBeLessThan(170000)
})

test('call rate measurement fails when reports stop', async ({ page }) => {
  await page.setContent('<div data-testid="call-screen" data-video-frames="0" data-audio-frames="0" data-sent-bytes="0"></div>')
  await expect(measureCallRates(page, 100, 200)).rejects.toThrow('Call media reports stopped')
})
