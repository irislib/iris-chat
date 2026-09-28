import { afterEach, describe, expect, it, vi } from 'vitest'
import { callAudioWorklet } from './callAudioWorklet'

type Message = { pcm?: Float32Array; playout?: number; capturedAt?: number }
interface Processor {
  port: { onmessage(event: { data: object }): void }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}

function processor() {
  const messages: Message[] = []
  let ProcessorClass!: new () => Processor
  const Base = class { port = { onmessage: () => {}, postMessage: (message: Message) => messages.push(message) } }
  new Function('AudioWorkletProcessor', 'registerProcessor', callAudioWorklet)(Base, (_name: string, value: typeof ProcessorClass) => { ProcessorClass = value })
  const node = new ProcessorClass()
  let samples = 0
  vi.stubGlobal('sampleRate', 48000)
  const process = (length: number) => {
    vi.stubGlobal('currentTime', samples / 48000)
    const input = Float32Array.from({ length }, (_, i) => samples + i)
    const output = new Float32Array(length)
    node.process([[input]], [[output]])
    samples += length
    return output
  }
  const message = (data: object) => node.port.onmessage({ data })
  return { process, message, messages }
}

afterEach(() => vi.unstubAllGlobals())

describe('production call audio worklet', () => {
  it('preserves complete 20 ms frames across variable capture callback sizes', () => {
    const p = processor()
    const captured: number[] = []
    const timestamps: number[] = []
    p.message({ active: true })
    for (const length of [128, 480, 64, 2048, 160]) {
      p.process(length)
      while (p.messages.filter(message => message.pcm).length) {
        // Collect and acknowledge each transfer, as the main-thread encoder does.
        const index = p.messages.findIndex(message => message.pcm)
        const [message] = p.messages.splice(index, 1)
        captured.push(...message.pcm!)
        timestamps.push(message.capturedAt!)
        p.message({ captured: true })
      }
    }
    expect(captured).toEqual(Array.from({ length: 2880 }, (_, i) => i))
    timestamps.forEach((timestamp, i) => expect(timestamp).toBeCloseTo(i * .02))
  })

  it('bounds stalled capture handoff and keeps the newest complete frames', () => {
    const p = processor()
    p.message({ active: true })
    for (let i = 0; i < 20; i++) p.process(960)
    expect(p.messages.filter(message => message.pcm)).toHaveLength(1)
    const starts: number[] = []
    for (let i = 0; i < 4; i++) {
      const frames = p.messages.filter(message => message.pcm)
      starts.push(frames[i].pcm![0])
      p.message({ captured: true })
    }
    expect(starts).toEqual([0, 17 * 960, 18 * 960, 19 * 960])
    expect(p.messages.filter(message => message.pcm)).toHaveLength(4)
  })

  it('requests audio from rendered sample counts even when capture is muted', () => {
    const p = processor()
    for (const length of [128, 2048, 704]) { p.process(length); p.message({ played: true }); p.message({ played: true }) }
    const requests = p.messages.filter(message => message.playout !== undefined)
    expect(requests).toHaveLength(3)
    requests.forEach((message, i) => expect(message.playout).toBeCloseTo((i + 1) * .02))
    expect(p.messages.some(message => message.pcm)).toBe(false)
  })

  it('coalesces missed device deadlines during a main-thread stall', () => {
    const p = processor()
    for (let i = 0; i < 20; i++) p.process(960)
    expect(p.messages.filter(message => message.playout !== undefined)).toHaveLength(1)
    p.message({ played: true })
    const requests = p.messages.filter(message => message.playout !== undefined)
    expect(requests).toHaveLength(2)
    expect(requests[1].playout).toBeCloseTo(.4)
  })

  it('discards queued microphone data when capture becomes inactive', () => {
    const p = processor()
    p.message({ active: true })
    p.process(2880)
    p.message({ active: false })
    p.message({ captured: true })
    expect(p.messages.filter(message => message.pcm)).toHaveLength(1)
  })
})
