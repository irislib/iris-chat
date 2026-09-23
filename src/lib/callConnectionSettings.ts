import { createPersistedSettings } from './createSettings'
export interface CallConnectionSettings extends Record<string, unknown> { servers: string[] }
const { store, update } = createPersistedSettings<CallConnectionSettings>('iris-chat-call-servers', {
  servers: ['wss://fips2.iris.to/fips', 'wss://fips1.iris.to/fips'],
}, value => ({ servers: Array.isArray(value.servers) ? value.servers.filter((url): url is string => typeof url === 'string').slice(0, 16) : [] }))
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
