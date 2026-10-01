import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { createAttachmentDraft, filesFromTransfer, hasFileData } from './attachmentDraft'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const file = (name: string) => new File(['sample'], name)
const revoke = vi.fn()
beforeEach(() => {
  revoke.mockClear()
  vi.stubGlobal('URL', { createObjectURL: (file: File) => `blob:${file.name}`, revokeObjectURL: revoke })
})
afterEach(() => vi.unstubAllGlobals())

describe('attachment draft uploads', () => {
  it('stages every file immediately, uploads in order and waits for explicit send', async () => {
    const first = deferred<{ nhash: string }>()
    const upload = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ nhash: 'second-hash' })
    const draft = createAttachmentDraft({ context: () => 'account:chat', upload, canPreview: () => true })
    const completed = draft.add([file('First.txt'), file('Second.txt')])
    expect(get(draft).map(item => item.file.name)).toEqual(['First.txt', 'Second.txt'])
    expect(upload).toHaveBeenCalledTimes(1)
    first.resolve({ nhash: 'first-hash' })
    expect(await completed).toEqual([0, 1])
    expect(get(draft).map(item => item.nhash)).toEqual(['first-hash', 'second-hash'])
    expect(get(draft).every(item => !item.uploading)).toBe(true)
    draft.clear()
    expect(revoke.mock.calls).toEqual([['blob:First.txt'], ['blob:Second.txt']])
  })

  it('cannot overwrite a replacement with progress, success or failure from a removed upload', async () => {
    for (const fails of [false, true]) {
      const old = deferred<{ nhash: string }>()
      const replacement = deferred<{ nhash: string }>()
      let progress!: (loaded: number, total: number) => void
      const upload = vi.fn().mockImplementationOnce((_file: File, callback: typeof progress) => { progress = callback; return old.promise })
        .mockReturnValueOnce(replacement.promise)
      const draft = createAttachmentDraft({ context: () => 'account:chat', upload, canPreview: () => true })
      const stale = draft.add([file('Old.txt')])
      draft.remove(get(draft)[0].id)
      const current = draft.add([file('New.txt')])
      progress(99, 100)
      if (fails) old.reject(new Error('late failure')); else old.resolve({ nhash: 'old-hash' })
      expect(await stale).toEqual([])
      expect(get(draft)).toMatchObject([{ file: { name: 'New.txt' }, progress: 0, error: null, nhash: null }])
      replacement.resolve({ nhash: 'new-hash' })
      await current
      expect(get(draft)[0].nhash).toBe('new-hash')
      expect(revoke).toHaveBeenCalledWith('blob:Old.txt')
    }
  })

  it.each(['account:other-chat', ':chat', 'other-account:chat'])('ignores a live context change to %s before the UI effect runs', async (next: string) => {
    let context = 'account:chat'
    const pending = deferred<{ nhash: string }>()
    const upload = vi.fn().mockReturnValue(pending.promise)
    const draft = createAttachmentDraft({ context: () => context, upload, canPreview: () => false })
    const completed = draft.add([file('First.txt'), file('Queued.txt')])
    context = next
    pending.resolve({ nhash: 'stale-hash' })
    expect(await completed).toEqual([])
    expect(get(draft)[0].nhash).toBeNull()
    expect(upload).toHaveBeenCalledTimes(1)
    draft.setContext(context)
    expect(get(draft)).toEqual([])
  })

  it('clearing a draft invalidates unfinished callbacks and skips removed queued files', async () => {
    const pending = deferred<{ nhash: string }>()
    const upload = vi.fn().mockReturnValue(pending.promise)
    const draft = createAttachmentDraft({ context: () => 'account:chat', upload, canPreview: () => false })
    const completed = draft.add([file('First.txt'), file('Queued.txt')])
    draft.clear()
    pending.resolve({ nhash: 'stale-hash' })
    expect(await completed).toEqual([])
    expect(get(draft)).toEqual([])
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed selection visible and independently removable', async () => {
    const upload = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ nhash: 'good-hash' })
    const draft = createAttachmentDraft({ context: () => 'account:chat', upload, canPreview: () => false })
    expect(await draft.add([file('Failed.txt'), file('Ready.txt')])).toEqual([1])
    expect(get(draft)[0]).toMatchObject({ error: 'Upload failed', uploading: false })
    draft.remove(0)
    expect(get(draft)).toMatchObject([{ nhash: 'good-hash', error: null }])
  })
})

describe('file transfer selection', () => {
  it('accepts clipboard file items alongside text without duplicating their file-list entries', () => {
    const image = new File(['png'], 'image.png', { type: 'image/png' })
    const document = new File(['document'], 'Notes.txt', { type: 'text/plain' })
    const items = [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      ...[image, document].map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    ]
    for (const files of [[image, document], []]) {
      const clipboard = { files, types: ['Files', 'text/plain'], items } as unknown as DataTransfer
      expect(filesFromTransfer(clipboard)).toEqual([image, document])
    }
  })

  it('preserves all actual files and ignores ordinary text and URL drags', () => {
    const files = [file('First.txt'), file('Second.pdf')]
    const data = { files, types: ['Files'], items: [] } as unknown as DataTransfer
    expect(hasFileData(data)).toBe(true)
    expect(filesFromTransfer(data)).toEqual(files)
    for (const types of [['text/plain'], ['text/uri-list']]) {
      const text = { files: [], types, items: [] } as unknown as DataTransfer
      expect(hasFileData(text)).toBe(false)
      expect(filesFromTransfer(text)).toBeNull()
    }
  })

  it('rejects a mixed file and directory drop without silently staging only part', () => {
    const data = {
      files: [file('Real.txt'), file('Folder')], types: ['Files'],
      items: [
        { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) },
        { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) },
      ],
    } as unknown as DataTransfer
    expect(filesFromTransfer(data)).toBeNull()
  })
})
