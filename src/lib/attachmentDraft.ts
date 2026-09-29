import { writable } from 'svelte/store'

export interface PendingAttachment {
  id: number
  file: File
  previewUrl: string | null
  nhash: string | null
  uploading: boolean
  progress: number
  error: string | null
}

type Upload = (file: File, progress: (loaded: number, total: number) => void) => Promise<{ nhash: string }>

/** One draft owns its previews and upload callbacks; a completed upload never sends. */
export function createAttachmentDraft(options: {
  context: () => string
  upload: Upload
  canPreview: (file: File) => boolean
}) {
  const store = writable<PendingAttachment[]>([])
  let items: PendingAttachment[] = []
  let context = options.context()
  let generation = 0
  let nextId = 0
  const publish = () => store.set(items)

  function remove(id: number) {
    const item = items.find(item => item.id === id)
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
    items = items.filter(item => item.id !== id)
    publish()
  }

  function clear() {
    generation++
    for (const item of items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    items = []
    publish()
  }

  function setContext(nextContext: string) {
    if (context !== nextContext) { clear(); context = nextContext }
  }

  async function add(files: File[]): Promise<number[]> {
    setContext(options.context())
    const startedIn = context
    const revision = generation
    const added = files.map(file => ({
      id: nextId++, file,
      previewUrl: options.canPreview(file) ? URL.createObjectURL(file) : null,
      nhash: null, uploading: true, progress: 0, error: null,
    } satisfies PendingAttachment))
    items = [...items, ...added]
    publish()
    const current = (id: number) => revision === generation && options.context() === startedIn && items.some(item => item.id === id)
    const update = (id: number, change: Partial<PendingAttachment>) => {
      if (!current(id)) return
      items = items.map(item => item.id === id ? { ...item, ...change } : item)
      publish()
    }
    const completed: number[] = []
    // Keep file order and avoid starting more uploads after leaving the draft.
    for (const item of added) {
      if (!current(item.id)) continue
      try {
        const result = await options.upload(item.file, (loaded, total) => {
          update(item.id, { progress: total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : 0 })
        })
        if (!current(item.id)) continue
        update(item.id, { nhash: result.nhash, uploading: false, progress: 100 })
        completed.push(item.id)
      } catch {
        update(item.id, { uploading: false, error: 'Upload failed' })
      }
    }
    return revision === generation && options.context() === startedIn
      ? completed.filter(id => items.some(item => item.id === id)) : []
  }

  return { subscribe: store.subscribe, add, remove, clear, setContext }
}

export function hasFileData(data: DataTransfer | null): boolean {
  return !!data && (data.files.length > 0 || Array.from(data.types).includes('Files'))
}

/** null means an unsupported selection; never silently omit a dropped folder. */
export function filesFromTransfer(data: DataTransfer | null): File[] | null {
  if (!data || !hasFileData(data)) return null
  const items = Array.from(data.items || []).filter(item => item.kind === 'file')
  if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) return null
  const files = data.files.length > 0 ? Array.from(data.files) : items.map(item => item.getAsFile()).filter((file): file is File => !!file)
  return files.length > 0 && files.every(file => !!file.name) ? files : null
}
