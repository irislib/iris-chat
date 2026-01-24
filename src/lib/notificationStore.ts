// Notification settings store with localStorage persistence

import { writable } from 'svelte/store'

export interface NotificationSettings {
  enabled: boolean
  serverUrl: string
  declined: boolean
}

const STORAGE_KEY = 'iris-chat-notifications'
const DEFAULT_SERVER_URL = 'https://notifications.iris.to'

function loadFromStorage(): NotificationSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch {
    // Ignore parse errors
  }
  return {
    enabled: false,
    serverUrl: DEFAULT_SERVER_URL,
    declined: false
  }
}

function saveToStorage(settings: NotificationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Ignore storage errors
  }
}

function createNotificationStore() {
  const initial = loadFromStorage()
  const { subscribe, set, update } = writable<NotificationSettings>(initial)

  return {
    subscribe,
    set: (value: NotificationSettings) => {
      saveToStorage(value)
      set(value)
    },
    update: (updater: (settings: NotificationSettings) => NotificationSettings) => {
      update((current) => {
        const updated = updater(current)
        saveToStorage(updated)
        return updated
      })
    },
    setEnabled: (enabled: boolean) => {
      update((current) => {
        const updated = { ...current, enabled }
        saveToStorage(updated)
        return updated
      })
    },
    setServerUrl: (serverUrl: string) => {
      update((current) => {
        const updated = { ...current, serverUrl }
        saveToStorage(updated)
        return updated
      })
    },
    setDeclined: (declined: boolean) => {
      update((current) => {
        const updated = { ...current, declined }
        saveToStorage(updated)
        return updated
      })
    },
    reset: () => {
      const defaults: NotificationSettings = {
        enabled: false,
        serverUrl: DEFAULT_SERVER_URL,
        declined: false
      }
      saveToStorage(defaults)
      set(defaults)
    }
  }
}

export const notificationSettings = createNotificationStore()
