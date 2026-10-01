import { writable } from 'svelte/store'

export interface DirectDraftFile { id: number; file: File }

/** An explicit direct selection stays local, including later drops and pastes. */
export function directFileSelectionMode(directCount: number, uploadCount: number, selectedDirectly: boolean): boolean {
  if (selectedDirectly && uploadCount > 0) throw new Error('Remove the uploaded files first')
  return directCount > 0 || selectedDirectly
}

export function createDirectFileDraft(context: () => string) {
  const store = writable<DirectDraftFile[]>([])
  let files: DirectDraftFile[] = []
  let activeContext = context()
  let nextId = 0
  const clear = () => { files = []; store.set(files) }
  function setContext(value: string) {
    if (value !== activeContext) { clear(); activeContext = value }
  }
  return {
    subscribe: store.subscribe,
    add(selected: File[]) {
      setContext(context())
      files = [...files, ...selected.map(file => ({ id: nextId++, file }))]
      store.set(files)
    },
    remove(id: number) { files = files.filter(file => file.id !== id); store.set(files) },
    clear,
    setContext,
  }
}

export function formatDirectFileSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes / 1_000
  let unit = 0
  while (size >= 1_000 && unit < units.length - 1) { size /= 1_000; unit++ }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(size)} ${units[unit]}`
}
