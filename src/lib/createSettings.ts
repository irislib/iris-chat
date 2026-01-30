import { writable, type Writable } from 'svelte/store'

export function createPersistedSettings<T extends Record<string, unknown>>(
  storageKey: string,
  defaults: T,
  migrate?: (parsed: Record<string, unknown>) => T | null,
): { store: Writable<T>; update: (patch: Partial<T>) => void } {
  function load(): T {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (migrate) {
          const migrated = migrate(parsed)
          if (migrated) return migrated
        }
        return parsed
      }
    } catch {}
    return defaults
  }

  const store = writable<T>(load())

  function update(patch: Partial<T>): void {
    store.update(s => {
      const updated = { ...s, ...patch }
      localStorage.setItem(storageKey, JSON.stringify(updated))
      return updated
    })
  }

  return { store, update }
}
