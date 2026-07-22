import { writable, type Writable } from 'svelte/store'

export function createPersistedSettings<T extends Record<string, unknown>>(
  storageKey: string,
  defaults: T,
  migrate?: (parsed: Record<string, unknown>) => T | null,
): { store: Writable<T>; update: (patch: Partial<T>) => void; reset: () => void } {
  function persist(settings: T): void {
    try {
      localStorage.setItem(storageKey, JSON.stringify(settings))
    } catch {}
  }

  function load(): T {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        const parsed = JSON.parse(stored) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...defaults }
        const settings = parsed as Record<string, unknown>
        return { ...defaults, ...(migrate?.(settings) ?? settings) }
      }
    } catch {}
    return { ...defaults }
  }

  const store = writable<T>(load())

  function update(patch: Partial<T>): void {
    store.update(s => {
      const updated = { ...s, ...patch }
      persist(updated)
      return updated
    })
  }

  function reset(): void {
    const settings = { ...defaults }
    persist(settings)
    store.set(settings)
  }

  return { store, update, reset }
}
