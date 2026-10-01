import { get } from 'svelte/store'
import { getEventHash } from 'nostr-tools'
import type { OnEventMeta, Rumor } from 'nostr-double-ratchet'
import { devices } from './devices'
import { getPubkey } from './identity'
import { waitForNdrRuntime } from './privateChats'
import { CHAT_MUTE_KIND, isChatMuteState, type ChatMuteState } from './chatMuteSync'
import { chatMuteStates, loadChatMutes, mergeChatMutes } from './chatMuteStore'

const replayRequests = new Set<(owner: string) => void>()
export function retryChatMuteSync(owner: string) { for (const request of replayRequests) request(owner) }

export async function sendChatMuteControl(owner: string, mute: ChatMuteState): Promise<void> {
  const runtime = await waitForNdrRuntime()
  if (getPubkey() !== owner || !get(devices).isCurrentDeviceRegistered) throw new Error('Device sync is not ready')
  const event = {
    kind: CHAT_MUTE_KIND,
    pubkey: owner,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', owner]],
    content: JSON.stringify({ type: 'chat-mute', v: 1, mute }),
  }
  // Address the account itself; the runtime queues only its sibling devices.
  const rumor = { ...event, id: getEventHash(event) }
  const accepted = await runtime.sendEvent(owner, rumor)
  if (getPubkey() !== owner || accepted?.id !== rumor.id) throw new Error('Mute setting was not queued')
}

export async function receiveChatMuteControl(rumor: Rumor, meta?: OnEventMeta): Promise<void> {
  const owner = getPubkey()
  const state = get(devices)
  const sender = meta?.senderDevicePubkey || meta?.fromDeviceId
  if (!owner || meta?.senderOwnerPubkey !== owner || !sender ||
    sender === state.identityPubkey || !state.isCurrentDeviceRegistered ||
    !state.registeredDevices.some(device => device.identityPubkey === sender) ||
    (rumor.pubkey !== owner && rumor.pubkey !== sender)) return
  let value
  try { value = JSON.parse(rumor.content) } catch { return }
  if (value?.type !== 'chat-mute' || value.v !== 1 || !isChatMuteState(value.mute)) return
  await mergeChatMutes([value.mute], owner)
}

/** Rebuild pending mute delivery from durable versions, including unmute tombstones. */
export function startChatMuteSync(owner: string): () => void {
  let stopped = false
  let requested = true
  let running: Promise<void> | undefined
  let roster = ''
  const drain = () => {
    if (stopped || !requested || running || getPubkey() !== owner || !get(devices).isCurrentDeviceRegistered) return
    requested = false
    running = (async () => {
      await loadChatMutes(owner)
      const versions = Object.values(get(chatMuteStates))
      for (const state of versions) {
        if (stopped || getPubkey() !== owner) return
        await sendChatMuteControl(owner, state)
      }
    })().catch(() => { requested = true }).finally(() => { running = undefined })
  }
  const request = () => { requested = true; drain() }
  const stopDevices = devices.subscribe(state => {
    const next = state.isCurrentDeviceRegistered ? state.registeredDevices.map(device => device.identityPubkey).sort().join(',') : ''
    if (next !== roster) { roster = next; request() }
  })
  const changed = (account: string) => { if (account === owner) request() }
  replayRequests.add(changed)
  window.addEventListener('online', request)
  const timer = setInterval(drain, 5000)
  request()
  return () => {
    stopped = true
    stopDevices()
    clearInterval(timer)
    window.removeEventListener('online', request)
    replayRequests.delete(changed)
  }
}
