import createOpus, { type OpusModule } from './opus/opus.js'
import wasmData from './opus/opus.wasm?url&inline'
let binary: ArrayBuffer | undefined
/** One pinned libopus path preserves 20 ms capture timing and supplies PLC/in-band FEC. */
export class CallOpus {
  private closed = false
  private constructor(private module: OpusModule) {}
  static async open() {
    // Bundle the codec with the app so the first call also works after going offline.
    binary ??= Uint8Array.from(atob(wasmData.slice(wasmData.indexOf(',') + 1)), char => char.charCodeAt(0)).buffer
    const module = await createOpus({ wasmBinary: binary })
    if (module._call_init() !== 0) throw new Error('Audio could not start')
    return new CallOpus(module)
  }
  encode(pcm: Float32Array): Uint8Array {
    if (this.closed || pcm.length !== 960) throw new Error('Invalid audio frame')
    this.module.HEAPF32.set(pcm, this.module._call_pcm() / 4)
    const count = this.module._call_encode()
    if (count < 1) throw new Error('Audio encoding failed')
    const offset = this.module._call_packet()
    return this.module.HEAPU8.slice(offset, offset + count)
  }
  decode(packet?: Uint8Array, fec = false): Float32Array | undefined {
    if (this.closed || (packet && (packet.length > 1275 || !packet.length))) return
    if (packet) this.module.HEAPU8.set(packet, this.module._call_packet())
    const count = this.module._call_decode(packet?.length ?? 0, fec ? 1 : 0)
    if (count < 0) return
    const offset = this.module._call_pcm() / 4
    return this.module.HEAPF32.slice(offset, offset + count)
  }
  close() { if (!this.closed) { this.closed = true; this.module._call_destroy() } }
}
