export interface OpusModule {
  HEAPF32: Float32Array
  HEAPU8: Uint8Array
  _call_init(): number
  _call_pcm(): number
  _call_packet(): number
  _call_encode(): number
  _call_decode(length: number, fec: number): number
  _call_destroy(): void
}
export default function createOpus(options: { wasmBinary: ArrayBuffer }): Promise<OpusModule>
