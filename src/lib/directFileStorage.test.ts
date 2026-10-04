// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { DirectFileStorage } from './directFileStorage'

vi.mock('./storage', () => ({ getSessionManagerValue: vi.fn(async () => undefined), putSessionManagerValue: vi.fn(async () => {}) }))
const storage = () => new DirectFileStorage('a'.repeat(64), 'b'.repeat(64))
const id = 'c'.repeat(32)
let saved: Uint8Array<ArrayBuffer>
let pending: ArrayBuffer[]
let picker: ReturnType<typeof vi.fn>
let writer: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }
let handle: { createWritable: ReturnType<typeof vi.fn>; getFile: ReturnType<typeof vi.fn> }
beforeEach(() => {
  saved = new TextEncoder().encode('previous contents'); pending = []
  writer = {
    write: vi.fn(async (bytes: ArrayBuffer) => { pending.push(bytes) }),
    close: vi.fn(async () => { saved = new Uint8Array(await new Blob(pending).arrayBuffer()) }),
    abort: vi.fn(async () => { pending = [] }),
  }
  handle = { createWritable: vi.fn(async () => writer), getFile: vi.fn(async () => new Blob([saved])) }
  picker = vi.fn(async () => handle)
  vi.stubGlobal('showSaveFilePicker', picker)
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('streams to the selected file and commits only after verification', async () => {
  const files = storage()
  await files.chooseDestination(id, [{ filename: 'report.bin' }])
  expect(picker).toHaveBeenCalledWith({ suggestedName: 'report.bin' })
  const sink = await files.createFile(id, 0)
  await sink.write(new Uint8Array([1, 2, 3]))
  expect(writer.write).toHaveBeenCalledOnce()
  await sink.finish()
  expect(writer.close).not.toHaveBeenCalled()
  expect(new TextDecoder().decode(saved)).toBe('previous contents')
  const result = await sink.commit!()
  expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([1, 2, 3])
})

it('aborts partial output without destroying a pre-existing chosen file', async () => {
  const files = storage()
  await files.chooseDestination(id, [{ filename: 'report.bin' }])
  const sink = await files.createFile(id, 0)
  await sink.write(new Uint8Array([1, 2, 3]))
  await sink.finish()
  await sink.abort()
  expect(writer.abort).toHaveBeenCalledOnce()
  expect(writer.close).not.toHaveBeenCalled()
  expect(new TextDecoder().decode(saved)).toBe('previous contents')
})

it('asks for one folder for a batch and gives collisions separate names', async () => {
  const names = new Set(['notes.txt'])
  const folder = { getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
    if (!options?.create && !names.has(name)) throw new DOMException('Missing', 'NotFoundError')
    if (options?.create) names.add(name)
    return handle
  }), removeEntry: vi.fn(async (name: string) => { names.delete(name) }) }
  const chooseFolder = vi.fn(async () => folder)
  vi.stubGlobal('showDirectoryPicker', chooseFolder)
  const files = storage()
  await files.chooseDestination(id, [{ filename: 'notes.txt' }, { filename: 'notes.txt' }])
  expect(chooseFolder).toHaveBeenCalledOnce()
  expect(picker).not.toHaveBeenCalled()
  const first = await files.createFile(id, 0), second = await files.createFile(id, 1)
  expect([...names]).toEqual(['notes.txt', 'notes (2).txt', 'notes (3).txt'])
  await first.abort(); await second.abort()
  expect([...names]).toEqual(['notes.txt'])
})
