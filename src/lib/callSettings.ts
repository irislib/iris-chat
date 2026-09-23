import { createPersistedSettings } from './createSettings'
import { normalizeCallQuality, type CallQualitySettings } from './callQuality'
export interface CallSettings extends Record<string, unknown>, CallQualitySettings { voice: boolean; video: boolean; ringtone?: boolean; notifications?: boolean }
const { store, update } = createPersistedSettings<CallSettings>('iris-chat-calls', { voice: true, video: true, ringtone: true, notifications: true, ...normalizeCallQuality({}) }, values => ({ voice: values.voice !== false, video: values.video !== false, ringtone: values.ringtone !== false, notifications: values.notifications !== false, ...normalizeCallQuality(values) }))
export const callSettings = store
export const setCallSettings = update
