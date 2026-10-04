import type { DirectFileSink } from './directFileTcp'
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

/** Stream to user-selected local files; retain read access to older private downloads. */
export class DirectFileStorage {
  private readonly destinations = new Map<string, Destination[]>()
  constructor(private readonly owner: string, private readonly device: string) {}

  private destinationKey(id: string, index: number) {
    return `v1/direct-file-destinations/${this.owner}/${this.device}/${id}/${index}`
  }

  async chooseDestination(id: string, files: { filename: string }[]): Promise<void> {
    const pickers = globalThis as typeof globalThis & FilePickers
    // Call the picker before any asynchronous setup consumes the click gesture.
    if (files.length === 1 && pickers.showSaveFilePicker) {
      const file = await pickers.showSaveFilePicker({ suggestedName: files[0].filename })
      this.destinations.set(id, [{ file }])
    } else if (pickers.showDirectoryPicker) {
      const directory = await pickers.showDirectoryPicker({ mode: 'readwrite' })
      this.destinations.set(id, files.map(file => ({ directory, filename: file.filename })))
    } else {
      throw new Error('This browser cannot choose a save location. Use Chrome, Edge, or the Iris app.')
    }
  }

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
    const destination = this.destinations.get(id)?.[index]
    if (!destination) throw new Error('Choose where to save these files first.')
    let handle: FileSystemFileHandle
    let removeCreated: (() => Promise<void>) | undefined
    if ('file' in destination) {
      handle = destination.file
    } else {
      let name = destination.filename
      for (let suffix = 2; ; suffix++) {
        try { await destination.directory.getFileHandle(name) }
        catch (error) {
          if (error instanceof DOMException && error.name === 'NotFoundError') break
          throw error
        }
        const dot = destination.filename.lastIndexOf('.')
        const base = dot > 0 ? destination.filename.slice(0, dot) : destination.filename
        const ext = dot > 0 ? destination.filename.slice(dot) : ''
        name = `${base} (${suffix})${ext}`
      }
      handle = await destination.directory.getFileHandle(name, { create: true })
      removeCreated = () => destination.directory.removeEntry(name)
    }
    let writer: FileSystemWritableFileStream
    try { writer = await handle.createWritable() }
    catch (error) { await removeCreated?.(); throw error }
    let closed = false
    return {
      write: async chunk => { await writer.write(new Uint8Array(chunk).buffer) },
      finish: async () => undefined,
      commit: async () => {
        await writer.close(); closed = true
        await putSessionManagerValue(this.destinationKey(id, index), handle).catch(() => {})
        return handle.getFile()
      },
      abort: async () => {
        if (!closed) await writer.abort().catch(() => undefined)
        closed = true
        await removeCreated?.().catch(() => undefined)
      },
    }
  }

  async getFile(id: string, index: number): Promise<File> {
    const destination = await getSessionManagerValue<FileSystemFileHandle>(this.destinationKey(id, index))
    if (destination) return destination.getFile()
    // Preserve access to completed files received by earlier app versions.
    const directory = await this.directory(id, false)
    return (await directory.getFileHandle(String(index))).getFile()
  }
}
