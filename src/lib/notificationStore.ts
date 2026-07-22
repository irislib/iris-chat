import { createPersistedSettings } from './createSettings'

export interface NotificationSettings extends Record<string, unknown> {
  enabled: boolean
  serverUrl: string
  declined: boolean
}

const DEFAULT_SERVER_URL = 'https://notifications.iris.to'
const defaults: NotificationSettings = {
  enabled: false,
  serverUrl: DEFAULT_SERVER_URL,
  declined: false,
}

const { store, update, reset } = createPersistedSettings(
  'iris-chat-notifications',
  defaults,
)

export const notificationSettings = {
  subscribe: store.subscribe,
  setEnabled: (enabled: boolean) => update({ enabled }),
  setServerUrl: (serverUrl: string) => update({ serverUrl }),
  setDeclined: (declined: boolean) => update({ declined }),
  reset,
}
