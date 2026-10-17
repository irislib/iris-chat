import type { Page } from '@playwright/test'

/** Measure complete media-report intervals, not the age of a cached UI report. */
export async function measureCallRates(page: Page, durationMs = 6000, timeoutMs = durationMs + 5000) {
  return page.getByTestId('call-screen').evaluate((element, { durationMs, timeoutMs }) => new Promise<{
    start: { at: number; video: number; audio: number; bytes: number }
    end: { at: number; video: number; audio: number; bytes: number }
    seconds: number; decodedFps: number; audioFps: number; payloadBps: number
  }>((resolve, reject) => {
    const read = () => ({ at: performance.now(),
      video: Number(element.getAttribute('data-video-frames')),
      audio: Number(element.getAttribute('data-audio-frames')),
      bytes: Number(element.getAttribute('data-sent-bytes')),
    })
    let start: ReturnType<typeof read> | undefined
    // Svelte updates the report's attributes together. The observer runs after
    // that update, in the browser that owns these counters and its clock.
    const observer = new MutationObserver(() => {
      const end = read()
      if (!start) { start = end; return }
      const seconds = (end.at - start.at) / 1000
      if (end.at - start.at < durationMs) return
      clearTimeout(timer); observer.disconnect()
      resolve({ start, end, seconds,
        decodedFps: (end.video - start.video) / seconds,
        audioFps: (end.audio - start.audio) / seconds,
        payloadBps: (end.bytes - start.bytes) * 8 / seconds,
      })
    })
    observer.observe(element, { attributes: true,
      attributeFilter: ['data-video-frames', 'data-audio-frames', 'data-sent-bytes'] })
    // Start at the next fresh report; existing DOM counters have unknown age.
    const timer = setTimeout(() => {
      observer.disconnect(); reject(new Error('Call media reports stopped during rate measurement'))
    }, timeoutMs)
  }), { durationMs, timeoutMs })
}
