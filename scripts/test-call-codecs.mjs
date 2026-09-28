import assert from 'node:assert/strict'
import { chromium, webkit } from '@playwright/test'
import { createServer } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
await server.listen()
const url = `http://127.0.0.1:${server.httpServer.address().port}`
const evidence = []
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.stack))
      page.on('requestfailed', request => console.log(name, 'request failed', request.url(), request.failure()?.errorText))
      page.on('console', message => { if (message.type() === 'error') console.log(name, message.text()) })
      await page.route('**/*', route => ['blob:', 'data:'].includes(new URL(route.request().url()).protocol) || new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
      await page.route('**/codec-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><button id="begin">Begin</button><button id="resume">Resume audio</button>' }))
      await page.goto(url + '/codec-test')
      await page.evaluate(async () => {
        const { BrowserCallMedia } = await import('/src/lib/callMedia.ts')
        const { CallMediaReceiver, encodeCallMedia } = await import('/src/lib/callProtocol.ts')
        const id = '12'.repeat(16), receivers = [new CallMediaReceiver(), new CallMediaReceiver()]
        const peers = [], stats = [], sources = [], errors = [], captured = [], keyframes = [], audioContexts = []
        let maxAudioDelayMs = 0
        document.getElementById('resume').onclick = () => { audioContexts.forEach(audio => { void audio.resume() }); peers.forEach(peer => { void peer.audioContext?.resume() }) }
        let dropAudio = false
        window.codecEvidence = { stats, errors, captured, keyframes, get maxAudioDelayMs() { return maxAudioDelayMs }, get debug() { return { getMedia: String(navigator.mediaDevices.getUserMedia).slice(0, 100), contexts: audioContexts.map(a => a.state), peers: peers.map(p => ({ active: p.active, opus: !!p.opus, stream: !!p.stream, context: p.audioContext?.state, node: !!p.audioNode })) } }, get sources() { return sources.map(s => s.stream.getTracks().map(t => t.getSettings())) }, set dropAudio(value) { dropAudio = value }, stop() { peers.forEach(p => p.stop()); sources.forEach(s => { clearInterval(s.timer); s.stream.getTracks().forEach(t => t.stop()); void s.audio.close() }) } }
        const capture = async constraints => {
          const audio = new AudioContext({ sampleRate: 48000 }), oscillator = audio.createOscillator(), gain = audio.createGain(), sink = audio.createMediaStreamDestination()
          audioContexts.push(audio); oscillator.frequency.value = 440; gain.gain.value = .2; oscillator.connect(gain); gain.connect(sink); oscillator.start(); void audio.resume()
          const canvas = document.createElement('canvas'); canvas.width = constraints.video.width.ideal; canvas.height = constraints.video.height.ideal
          const ctx = canvas.getContext('2d'); let frame = 0
          const draw = () => { frame++; ctx.fillStyle = '#27424d'; ctx.fillRect(0, 0, canvas.width, canvas.height); for (let i = 0; i < 60; i++) { ctx.fillStyle = `hsl(${i * 17 + frame},70%,55%)`; ctx.fillRect((i * 97 + frame * 7) % canvas.width, (i * 71 + frame * 3) % canvas.height, 130, 100) } }
          draw(); const timer = setInterval(draw, 33)
          const stream = new MediaStream([...sink.stream.getAudioTracks(), ...canvas.captureStream(30).getVideoTracks()]); sources.push({ audio, stream, timer }); return stream
        }
        Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', { configurable: true, value: capture })
        document.getElementById('begin').onclick = async () => {
          try {
            for (let i = 0; i < 2; i++) peers.push(new BrowserCallMedia({
              send: async frame => {
                if (frame.kind === 1) maxAudioDelayMs = Math.max(maxAudioDelayMs, (performance.now() - peers[i].epoch) - frame.timestamp / 1000)
                const nals = []
                if (frame.kind === 2 && frame.key) for (let at = 0; at < frame.bytes.length - 4; at++) {
                  if (frame.bytes[at] || frame.bytes[at + 1]) continue
                  const header = frame.bytes[at + 2] === 1 ? at + 3 : !frame.bytes[at + 2] && frame.bytes[at + 3] === 1 ? at + 4 : -1
                  if (header >= 0) nals.push(frame.bytes[header] & 31)
                }
                if (frame.kind === 2 && frame.key) { keyframes.push(nals); if (keyframes.length > 10) keyframes.shift() }
                captured.push({ kind: frame.kind, key: frame.key, size: frame.bytes.length, nals }); if (captured.length > 100) captured.shift()
                if (dropAudio && frame.kind === 1 && frame.seq % 5 === 0) return
                for (const packet of encodeCallMedia(id, frame)) { const decoded = receivers[1 - i].receive(id, packet); if (decoded) peers[1 - i].receive(decoded) }
              }, remoteVideo: () => {}, feedback: value => peers[1 - i].feedback({ v: 3, type: 'feedback', call_id: id, ...value }), highestVideo: () => receivers[i].highestVideo,
              requestKeyframe: () => peers[1 - i].requestKeyframe(), stats: value => { stats[i] = value }, error: error => errors.push(error.message),
            }))
            await Promise.all(peers.map(p => p.open(true, { quality: 'high' })))
            peers.forEach(p => p.setState(true, false, true, true))
          } catch (error) { errors.push(String(error)) }
        }
      })
      await page.click('#begin')
      for (let tries = 0; tries < 60; tries++) { await page.click('#resume'); if (await page.evaluate(() => window.codecEvidence.errors.length || (window.codecEvidence.stats.length === 2 && window.codecEvidence.stats.every(s => s.receivedAudio > 10 && s.receivedVideo > 10)))) break; await new Promise(resolve => setTimeout(resolve, 500)) }
      let result = await page.evaluate(() => ({ ...window.codecEvidence, stop: undefined }))
      assert.deepEqual(result.errors, [], `${name} codec errors`)
      assert.equal(result.stats.length, 2, JSON.stringify(result))
      assert.ok(result.stats.every(s => s.receivedAudio > 10 && s.receivedVideo > 10), JSON.stringify(result))
      for (const stats of result.stats) {
        assert.equal(stats.videoWidth, 1920); assert.equal(stats.videoHeight, 1080)
        assert.ok(stats.audioEnergy > .001)
      }
      const beforeStall = result.stats.map(s => ({ audio: s.receivedAudio, video: s.receivedVideo }))
      // The hardware render thread continues while UI work blocks JavaScript.
      await page.evaluate(() => { const until = performance.now() + 350; while (performance.now() < until) {} })
      await page.waitForFunction(before => window.codecEvidence.stats.every((s, i) => s.receivedAudio > before[i].audio + 20 && s.receivedVideo > before[i].video + 5), beforeStall, { timeout: 10000 }).catch(async error => {
        console.error(name, 'UI-stall recovery failed', JSON.stringify(await page.evaluate(() => ({ stats: window.codecEvidence.stats, errors: window.codecEvidence.errors, debug: window.codecEvidence.debug, maxAudioDelayMs: window.codecEvidence.maxAudioDelayMs }))))
        throw error
      })
      assert.ok(await page.evaluate(() => window.codecEvidence.maxAudioDelayMs < 160), `${name} must not transmit stale audio after a UI stall`)
      await page.evaluate(() => { window.codecEvidence.dropAudio = true })
      await page.waitForFunction(() => window.codecEvidence.stats.every(s => s.concealedAudio >= 5), { timeout: 10000 })
      result = await page.evaluate(() => ({ ...window.codecEvidence, stop: undefined }))
      assert.deepEqual(errors, [], `${name} page errors`)
      assert.ok(result.keyframes.some(nals => [5, 7, 8].every(nal => nals.includes(nal))), `${name} Annex B IDR includes SPS/PPS`)
      evidence.push({ name, ...result })
      await page.evaluate(() => window.codecEvidence.stop())
      console.log(`${name}: bidirectional 1080p H.264 and Opus decode; UI-stall recovery and loss concealment passed`)
    } finally { await browser.close() }
  }
} finally { await server.close(); await mkdir('work/calls', { recursive: true }); await writeFile('work/calls/codecs.json', JSON.stringify(evidence, null, 2)) }
