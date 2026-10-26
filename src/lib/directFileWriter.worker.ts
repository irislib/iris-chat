// OPFS synchronous handles update in place, avoiding whole-prefix copies at each checkpoint.
interface AccessHandle {
  write(data: Uint8Array, options: { at: number }): number
  flush(): void
  close(): void
}
interface Request {
  id: number; operation: 'write' | 'flush' | 'close'; key: string
  file?: FileSystemFileHandle & { createSyncAccessHandle(): Promise<AccessHandle> }
  bytes?: ArrayBuffer; offset?: number
}
const handles = new Map<string, AccessHandle>()
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<Request>) => void; postMessage(value: unknown): void }
let queue = Promise.resolve()
scope.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      let handle = handles.get(data.key)
      if (data.operation === 'write') {
        if (!handle) {
          if (!data.file?.createSyncAccessHandle) throw new Error('This browser cannot receive files directly. Try a newer browser.')
          handle = await data.file.createSyncAccessHandle(); handles.set(data.key, handle)
        }
        const bytes = new Uint8Array(data.bytes!)
        if (handle.write(bytes, { at: data.offset! }) !== bytes.length) throw new Error('Received file was not saved completely')
      } else if (data.operation === 'flush') handle?.flush()
      else { handle?.flush(); handle?.close(); handles.delete(data.key) }
      scope.postMessage({ id: data.id })
    } catch (error) {
      scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : 'Could not save received files.' })
    }
  })
}
