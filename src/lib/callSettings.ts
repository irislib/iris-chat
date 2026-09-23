import { createPersistedSettings } from './createSettings'
export interface CallSettings extends Record<string, unknown> { voice: boolean; video: boolean; ringtone?: boolean }
const { store, update } = createPersistedSettings<CallSettings>('iris-chat-calls', { voice: true, video: true, ringtone: true }, values => ({ voice: values.voice !== false, video: values.video !== false, ringtone: values.ringtone !== false }))
export const callSettings = store
export const setCallSettings = update
