// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { DirectFileStorage } from './directFileStorage'

vi.mock('./directFileWriter', () => ({ DirectFileWriter: class {
  private writers = new Map<string, any>()
  async write(key: string, file: FileSystemFileHandle, bytes: Uint8Array, offset: number) {
    let writer = this.writers.get(key)
    if (!writer) { writer = await file.createWritable({ keepExistingData: true }); this.writers.set(key, writer) }
    await writer.seek(offset); await writer.write(bytes.slice().buffer)
  }
  async flush(key: string) { await this.close(key) }
  async close(key: string) { await this.writers.get(key)?.close(); this.writers.delete(key) }
  dispose() {}
} }))
const metadata = new Map<string, unknown>()
vi.mock('./storage', () => ({
  getSessionManagerValue: vi.fn(async (key: string) => metadata.get(key)),
  putSessionManagerValue: vi.fn(async (key: string, value: unknown) => { metadata.set(key, value) }),
}))
const storage = () => new DirectFileStorage('a'.repeat(64), 'b'.repeat(64))
const id = 'c'.repeat(32)
function file(initial = new Uint8Array()) {
  let saved = new Uint8Array(initial)
  return {
    getFile: async () => new Blob([saved]),
    createWritable: vi.fn(async (options?: { keepExistingData?: boolean }) => {
      let pending = options?.keepExistingData ? new Uint8Array(saved) : new Uint8Array(), cursor = 0
      return {
        seek: async (offset: number) => { cursor = offset },
        write: async (data: ArrayBuffer) => {
          const bytes = new Uint8Array(data), next = new Uint8Array(Math.max(pending.length, cursor + bytes.length))
          next.set(pending); next.set(bytes, cursor); pending = next; cursor += bytes.length
        },
        close: async () => { saved = pending },
        abort: async () => {},
      }
    }),
  }
}
interface Directory {
  files: Map<string, ReturnType<typeof file>>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Directory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<ReturnType<typeof file>>
  removeEntry(name: string): Promise<void>
}
function directory(): Directory {
  const files = new Map<string, ReturnType<typeof file>>()
  const directories = new Map<string, Directory>()
  return {
    files,
    getDirectoryHandle: async (name: string, options?: { create?: boolean }): Promise<Directory> => {
      if (!directories.has(name)) {
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError')
        directories.set(name, directory())
      }
      return directories.get(name)!
    },
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError')
        files.set(name, file())
      }
      return files.get(name)!
    },
    removeEntry: async (name: string) => { files.delete(name) },
  }
}
let destination: ReturnType<typeof file>
beforeEach(() => {
  metadata.clear()
  const root = directory()
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } })
  destination = file(new TextEncoder().encode('previous contents'))
  vi.stubGlobal('showSaveFilePicker', vi.fn(async () => destination))
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
const bytes = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())]

it('checkpoints privately and changes the chosen file only after verification', async () => {
  const files = storage()
  await files.chooseDestination(id, [{ filename: 'report.bin' }])
  const sink = await files.createFile(id, 0)
  await sink.write(new Uint8Array([1, 2, 3])); await sink.finish()
  expect(await (await destination.getFile()).text()).toBe('previous contents')
  expect(await bytes(await sink.commit!())).toEqual([1, 2, 3])
  expect(await bytes(await destination.getFile())).toEqual([1, 2, 3])
  await sink.commit!()
  expect(destination.createWritable).toHaveBeenCalledOnce()
})

it('restores the durable prefix after a new storage instance without a new picker', async () => {
  const sink = await storage().createFile(id, 0)
  await sink.write(new Uint8Array([1, 2, 3])); await sink.suspend!()
  const resumed = await storage().createFile(id, 0)
  expect(await bytes(resumed.retained!)).toEqual([1, 2, 3])
  await resumed.write(new Uint8Array([4, 5])); await resumed.finish()
  expect(await bytes(await resumed.commit!())).toEqual([1, 2, 3, 4, 5])
})

it('supports browsers without destination pickers through disk-backed downloads', async () => {
  vi.stubGlobal('showSaveFilePicker', undefined)
  vi.stubGlobal('showDirectoryPicker', undefined)
  const files = storage()
  await files.chooseDestination(id, [{ filename: 'phone.bin' }])
  const sink = await files.createFile(id, 0)
  await sink.write(new Uint8Array([7, 8])); await sink.finish(); await sink.commit!()
  expect(await bytes(await storage().getFile(id, 0))).toEqual([7, 8])
})

it('cancel removes only owned staging and preserves the selected existing file', async () => {
  const files = storage()
  await files.chooseDestination(id, [{ filename: 'report.bin' }])
  const sink = await files.createFile(id, 0)
  await sink.write(new Uint8Array([1, 2, 3])); await sink.suspend!(); await sink.abort()
  expect(await (await destination.getFile()).text()).toBe('previous contents')
  expect((await storage().createFile(id, 0)).retained!.size).toBe(0)
})

it('assigns distinct collision names and keeps them stable on completed replay', async () => {
  const folder = directory()
  await folder.getFileHandle('notes.txt', { create: true })
  vi.stubGlobal('showDirectoryPicker', vi.fn(async () => folder))
  const files = storage()
  await files.chooseDestination(id, [{ filename: 'notes.txt' }, { filename: 'notes.txt' }])
  for (const index of [0, 1]) {
    const sink = await files.createFile(id, index)
    await sink.write(new Uint8Array([index])); await sink.finish(); await sink.commit!()
  }
  expect([...folder.files.keys()]).toEqual(['notes.txt', 'notes (2).txt', 'notes (3).txt'])
  await (await storage().createFile(id, 0)).commit!()
  expect([...folder.files.keys()]).toHaveLength(3)
})
