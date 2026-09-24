import assert from 'node:assert/strict'
import { chromium, webkit } from '@playwright/test'
import { createServer } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'

const engines = { chromium, webkit }
const names = process.argv.slice(2)
for (const name of names) assert.ok(engines[name], `Unknown browser: ${name}`)
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const evidence = [], failures = []
try {
  for (const name of names.length ? names : Object.keys(engines)) {
    const browser = await engines[name].launch({ headless: true, args: name === 'chromium' ? ['--autoplay-policy=no-user-gesture-required'] : [] })
    try {
      const page = await browser.newPage()
      page.on('pageerror', error => failures.push(`${name}: ${error.message}`))
      await page.route('**/*', route => ['blob:', 'data:'].includes(new URL(route.request().url()).protocol) || new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
      await page.route('**/bitrate-bench', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><button id="begin">Start benchmark</button>' }))
      await page.goto(origin + '/bitrate-bench')
      await page.evaluate(() => {
        document.querySelector('#begin').onclick = async () => {
          try { window.bench = await (await import('/e2e/fixtures/callBitrateBench.ts')).startBitrateBench() }
          catch (error) { window.benchError = String(error) }
        }
      })
      await page.click('#begin')
      await page.waitForFunction(() => window.bench || window.benchError, undefined, { timeout: 30000 })
      assert.equal(await page.evaluate(() => window.benchError), undefined)
      for (const args of [
        ['fast', [4_000_000, 4_000_000], 8],
        ['400k', [400_000, 400_000], 20],
        ['256k-asymmetric', [256_000, 800_000], 20],
        ['recovered', [4_000_000, 4_000_000], 25],
        ['loss-and-jitter', [4_000_000, 4_000_000], 12, 100, false, 30],
        ['feedback-outage', [4_000_000, 4_000_000], 8, 0, true],
        ['feedback-restored', [4_000_000, 4_000_000], 25],
      ]) {
        const phase = args[0]
        const result = await page.evaluate(args => window.bench.phase(...args), args)
        evidence.push({ browser: name, ...result }); console.log('CALL_BITRATE', JSON.stringify({ browser: name, ...result }))
        if (result.errors.length || result.states.some(state => state !== 'active')) failures.push(`${name}/${phase}: call failed: ${JSON.stringify(result.errors)}`)
        for (const peer of result.peers) {
          if (peer.decodedFps < 8 || peer.maxFreezeMs > 1500 || peer.p95FrameAgeMs === null || peer.p95FrameAgeMs > 400 || peer.audioFps < 30) failures.push(`${name}/${phase}/${peer.side}: insufficient sustained media`)
          if (['recovered', 'feedback-restored'].includes(phase) && peer.target < 500_000) failures.push(`${name}/${phase}/${peer.side}: bitrate did not recover`)
          if (phase === 'feedback-outage' && peer.target >= peer.targets[0]?.bps) failures.push(`${name}/${phase}/${peer.side}: missing feedback did not reduce the target`)
        }
      }
      await page.evaluate(() => window.bench.stop())
    } finally { await browser.close() }
  }
} finally {
  await server.close(); await mkdir('work/calls', { recursive: true })
  await writeFile('work/calls/bitrate-bench.json', JSON.stringify({ evidence, failures }, null, 2))
}
assert.deepEqual(failures, [], 'Adaptive calls must keep decoding under bandwidth limits')
