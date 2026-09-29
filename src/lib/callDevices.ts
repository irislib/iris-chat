import { createPersistedSettings } from './createSettings'

export interface CallDevicePreferences extends Record<string, unknown> {
  microphone: string
  speaker: string
}
export interface CallDeviceState extends CallDevicePreferences {
  microphones: Array<{ id: string; label: string }>
  speakers: Array<{ id: string; label: string }>
  canSelectSpeaker: boolean
}
export type CallDeviceKind = 'microphone' | 'speaker'
export type RoutedAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string }

const settings = createPersistedSettings<CallDevicePreferences>('iris-chat-call-devices', {
  microphone: '', speaker: '',
}, value => ({
  microphone: typeof value.microphone === 'string' ? value.microphone : '',
  speaker: typeof value.speaker === 'string' ? value.speaker : '',
}))
export const callDevicePreferences = settings.store
export const setCallDevicePreferences = settings.update

export function deviceOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind) {
  return devices.filter(device => device.kind === kind && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
    .map((device, index) => ({ id: device.deviceId, label: device.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${index + 1}` }))
}
