import type { DirectFileSink } from './directFileTcp'

export async function clearDirectFileStorage(): Promise<void> {
  if (!globalThis.navigator?.storage?.getDirectory) return
  const root = await navigator.storage.getDirectory()
  await root.removeEntry('iris-chat-direct-files', { recursive: true }).catch(error => {
    if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
  })
}

/** Browser-private local files, never attachment blocks or public storage. */
export class DirectFileStorage {
  constructor(private readonly owner: string, private readonly device: string) {}

  private async directory(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    if (![this.owner, this.device].every(value => /^[0-9a-f]{64}$/.test(value)) || !/^[0-9a-f]{32}$/.test(id)) {
      throw new Error('Invalid file transfer.')
    }
    if (!navigator.storage?.getDirectory) throw new Error('This browser cannot receive files directly. Try a newer browser.')
    let directory = await navigator.storage.getDirectory()
    for (const name of ['iris-chat-direct-files', this.owner, this.device, id]) {
      directory = await directory.getDirectoryHandle(name, { create })
    }
    return directory
  }

  async createFile(id: string, index: number): Promise<DirectFileSink> {
    const directory = await this.directory(id, true)
    const name = String(index)
    try {
      await directory.getFileHandle(name)
      throw new Error('These files have already been received.')
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
    }
    const handle = await directory.getFileHandle(name, { create: true })
    let writer: FileSystemWritableFileStream
    try { writer = await handle.createWritable() }
    catch (error) { await directory.removeEntry(name); throw error }
    let closed = false
    return {
      write: async chunk => { await writer.write(new Uint8Array(chunk).buffer) },
      finish: async () => { await writer.close(); closed = true; return handle.getFile() },
      abort: async () => {
        if (!closed) await writer.abort().catch(() => undefined)
        closed = true
        await directory.removeEntry(name).catch(() => undefined)
      },
    }
  }

  async getFile(id: string, index: number): Promise<File> {
    const directory = await this.directory(id, false)
    return (await directory.getFileHandle(String(index))).getFile()
  }
}
