import { expect, it } from 'vitest'
import { CallOpus } from './callOpus'
it('bundled Opus encodes speech-sized packets, decodes audio and conceals a lost packet', async () => {
  const codec = await CallOpus.open()
  let energy = 0
  for (let frame = 0; frame < 10; frame++) {
    const pcm = Float32Array.from({ length: 960 }, (_, i) => .3 * Math.sin((frame * 960 + i) * 2 * Math.PI * 440 / 48000))
    const packet = codec.encode(pcm)
    expect(packet.length).toBeGreaterThan(0)
    expect(packet.length).toBeLessThanOrEqual(1275)
    const decoded = codec.decode(packet)!
    expect(decoded.length).toBe(960)
    energy += decoded.reduce((sum, value) => sum + value * value, 0)
  }
  expect(energy).toBeGreaterThan(1)
  const concealed = codec.decode()!
  expect(concealed.length).toBe(960)
  expect(concealed.some(sample => sample !== 0)).toBe(true)
  codec.close()
  expect(codec.decode()).toBeUndefined()
})
