import { createPersistedSettings } from './createSettings'
export const DEFAULT_CALL_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
]
export interface CallConnectionSettings extends Record<string, unknown> { servers: string[]; stunServers: string[] }
const { store, update } = createPersistedSettings<CallConnectionSettings>('iris-chat-call-servers', {
  servers: ['wss://fips2.iris.to/fips', 'wss://fips1.iris.to/fips'],
  stunServers: DEFAULT_CALL_STUN_SERVERS,
}, value => ({
  servers: Array.isArray(value.servers) ? value.servers.filter((url): url is string => typeof url === 'string').slice(0, 16) : [],
  // Preserve an explicit empty list for local-only setups; migrate saved settings.
  stunServers: Array.isArray(value.stunServers)
    ? value.stunServers.filter((url): url is string => typeof url === 'string' && /^stuns?:[^\s/?#@]+$/.test(url)).slice(0, 4)
    : DEFAULT_CALL_STUN_SERVERS,
}))
export const callConnectionSettings = store
export function setCallServers(text: string): void {
  const servers = [...new Set(text.split(/[\s,]+/).filter(Boolean).map(value => {
    const url = new URL(value)
    if (url.username || url.password || url.hash || !['ws:', 'wss:'].includes(url.protocol)) throw new Error('Enter a valid call server address')
    if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Use a secure address starting with wss://')
    return url.toString()
  }))]
  if (!servers.length || servers.length > 16) throw new Error('Enter between 1 and 16 call servers')
  update({ servers })
}
