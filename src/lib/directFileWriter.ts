/** One worker per signed-in identity; each awaited write bounds queued payloads. */
export class DirectFileWriter {
  private worker?: Worker
  private sequence = 0
  private readonly pending = new Map<number, { resolve(): void; reject(error: Error): void }>()
  private request(operation: string, key: string, file?: FileSystemFileHandle, bytes?: Uint8Array, offset?: number): Promise<void> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./directFileWriter.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = ({ data }: MessageEvent<{ id: number; error?: string }>) => {
        const pending = this.pending.get(data.id)
        this.pending.delete(data.id)
        if (data.error) pending?.reject(new Error(data.error))
        else pending?.resolve()
      }
      this.worker.onerror = () => {
        for (const pending of this.pending.values()) pending.reject(new Error('Could not save received files.'))
        this.pending.clear()
      }
    }
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const payload = bytes?.slice().buffer
      try { this.worker!.postMessage({ id, operation, key, file, bytes: payload, offset }, payload ? [payload] : []) }
      catch (error) { this.pending.delete(id); reject(error) }
    })
  }
  write(key: string, file: FileSystemFileHandle, bytes: Uint8Array, offset: number): Promise<void> {
    return this.request('write', key, file, bytes, offset)
  }
  flush(key: string): Promise<void> { return this.request('flush', key) }
  close(key: string): Promise<void> { return this.request('close', key) }
  dispose(): void {
    this.worker?.terminate(); this.worker = undefined
    for (const pending of this.pending.values()) pending.reject(new Error('File storage closed.'))
    this.pending.clear()
  }
}
