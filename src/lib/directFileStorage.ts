import { DirectFileWriter } from './directFileWriter'
import type { DirectFileClaim, DirectFileSink, DirectFileStateStore } from './directFileTcp'
import { getSessionManagerValue, putSessionManagerValue } from './storage'

type Destination = { file: FileSystemFileHandle } | { directory: FileSystemDirectoryHandle; filename: string }
type FilePickers = {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}

export async function clearDirectFileStorage(): Promise<void> {
  if (!globalThis.navigator?.storage?.getDirectory) return
  const root = await navigator.storage.getDirectory()
  await root.removeEntry('iris-chat-direct-files', { recursive: true }).catch(error => {
    if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
  })
}

/** Private durable staging works on Safari/Firefox/mobile as well as desktop pickers. */
export class DirectFileStorage {
  private readonly writer = new DirectFileWriter()
  dispose(): void { this.writer.dispose() }
  readonly claims: DirectFileStateStore = {
    load: key => getSessionManagerValue<DirectFileClaim>(this.key(`claims/${key}`)),
    save: (key, claim) => putSessionManagerValue(this.key(`claims/${key}`), claim),
  }
  constructor(private readonly owner: string, private readonly device: string) {}
  private key(suffix: string) { return `v2/direct-files/${this.owner}/${this.device}/${suffix}` }
  private destinationKey(id: string, index: number) {
    return `v1/direct-file-destinations/${this.owner}/${this.device}/${id}/${index}`
  }
  saveSources(id: string, files: Blob[]): Promise<void> { return putSessionManagerValue(this.key(`sources/${id}`), files) }
  loadSources(id: string): Promise<Blob[] | undefined> { return getSessionManagerValue(this.key(`sources/${id}`)) }
  async forgetSources(id: string): Promise<void> { await putSessionManagerValue(this.key(`sources/${id}`), undefined) }

  async chooseDestination(id: string, files: { filename: string }[]): Promise<void> {
    const pickers = globalThis as typeof globalThis & FilePickers
    let destinations: Destination[] | undefined
    // Invoke a picker synchronously with the acceptance gesture.
    if (files.length === 1 && pickers.showSaveFilePicker) {
      destinations = [{ file: await pickers.showSaveFilePicker({ suggestedName: files[0].filename }) }]
    } else if (pickers.showDirectoryPicker) {
      const directory = await pickers.showDirectoryPicker({ mode: 'readwrite' })
      destinations = files.map(file => ({ directory, filename: file.filename }))
    }
    if (destinations) await putSessionManagerValue(this.key(`destinations/${id}`), destinations)
    await this.directory(id, true)
  }

  private async directory(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    if (![this.owner, this.device].every(value => /^[0-9a-f]{64}$/.test(value)) || !/^[0-9a-f]{32}$/.test(id)) {
      throw new Error('Invalid file transfer.')
    }
    if (!navigator.storage?.getDirectory) throw new Error('This browser cannot receive files directly. Try a newer browser.')
    let directory: FileSystemDirectoryHandle
    try { directory = await navigator.storage.getDirectory() }
    catch { throw new Error('File storage is unavailable. Try a regular browser window.') }
    for (const name of ['iris-chat-direct-files', this.owner, this.device, id]) {
      directory = await directory.getDirectoryHandle(name, { create })
    }
    return directory
  }

  async retainedBytes(id: string, files: { size_bytes: number }[]): Promise<number> {
    const directory = await this.directory(id, false).catch(() => undefined)
    if (!directory) return 0
    let total = 0
    for (const [index, expected] of files.entries()) {
      const size = await directory.getFileHandle(String(index)).then(handle => handle.getFile()).then(file => file.size, () => 0)
      if (size > expected.size_bytes) break
      total += size
      if (size < expected.size_bytes) break
    }
    return total
  }

  async discard(id: string): Promise<void> {
    const directory = await this.directory(id, false).catch(() => undefined)
    if (!directory) return
    // Only this transfer's known staging entries are owned here.
    for (let index = 0; index < 32; index++) await directory.removeEntry(String(index)).catch(error => {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
    })
  }

  private async destination(id: string, index: number): Promise<FileSystemFileHandle | undefined> {
    const saved = await getSessionManagerValue<FileSystemFileHandle>(this.destinationKey(id, index))
    if (saved) return saved
    const destination = (await getSessionManagerValue<Destination[]>(this.key(`destinations/${id}`)))?.[index]
    if (!destination) return
    let handle: FileSystemFileHandle
    if ('file' in destination) handle = destination.file
    else {
      let name = destination.filename
      for (let suffix = 2; ; suffix++) {
        try { await destination.directory.getFileHandle(name) }
        catch (error) {
          if (error instanceof DOMException && error.name === 'NotFoundError') break
          throw error
        }
        const dot = destination.filename.lastIndexOf('.')
        name = `${dot > 0 ? destination.filename.slice(0, dot) : destination.filename} (${suffix})${dot > 0 ? destination.filename.slice(dot) : ''}`
      }
      handle = await destination.directory.getFileHandle(name, { create: true })
    }
    await putSessionManagerValue(this.destinationKey(id, index), handle)
    return handle
  }

  async createFile(id: string, index: number): Promise<DirectFileSink> {
    const directory = await this.directory(id, true)
    const handle = await directory.getFileHandle(String(index), { create: true })
    const retained = await handle.getFile()
    let offset = retained.size, checkpoint = offset
    const writerKey = `${id}/${index}`
    const flush = async () => { await this.writer.close(writerKey); checkpoint = offset }
    return {
      retained,
      write: async chunk => {
        await this.writer.write(writerKey, handle, chunk, offset); offset += chunk.length
        // Flush bounded checkpoints in place; recovery measures and hashes the retained file.
        if (offset - checkpoint >= 1024 * 1024) { await this.writer.flush(writerKey); checkpoint = offset }
      },
      finish: async () => { await flush(); return undefined },
      suspend: flush,
      commit: async signal => {
        signal?.throwIfAborted()
        await flush()
        const result = await handle.getFile()
        if (await getSessionManagerValue<boolean>(this.key(`exported/${id}/${index}`))) return result
        const destination = await this.destination(id, index)
        if (destination) {
          const output = await destination.createWritable()
          try {
            for (let start = 0; start < result.size; start += 64 * 1024) {
              signal?.throwIfAborted()
              await output.write(await result.slice(start, start + 64 * 1024).arrayBuffer())
            }
            signal?.throwIfAborted()
            await output.close()
          } catch (error) { await output.abort().catch(() => undefined); throw error }
          await putSessionManagerValue(this.key(`exported/${id}/${index}`), true)
        }
        return result
      },
      abort: async () => {
        await this.writer.close(writerKey).catch(() => undefined)
        await directory.removeEntry(String(index)).catch(() => undefined)
      },
    }
  }

  async getFile(id: string, index: number): Promise<File> {
    // The private verified file remains available even if external permission expires.
    try { return await (await (await this.directory(id, false)).getFileHandle(String(index))).getFile() }
    catch {
      const destination = await getSessionManagerValue<FileSystemFileHandle>(this.destinationKey(id, index))
      if (destination) return destination.getFile()
      throw new Error('This file is no longer on this device.')
    }
  }
}
