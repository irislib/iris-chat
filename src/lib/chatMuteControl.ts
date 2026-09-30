import { get } from 'svelte/store'
import { getEventHash } from 'nostr-tools'
import type { OnEventMeta, Rumor } from 'nostr-double-ratchet'
import { devices } from './devices'
import { getPubkey } from './identity'
import { waitForNdrRuntime } from './privateChats'
import { CHAT_MUTE_KIND, isChatMuteState, type ChatMuteState } from './chatMuteSync'
import { mergeChatMutes } from './chatMuteStore'

export async function sendChatMuteControl(owner: string, mute: ChatMuteState): Promise<void> {
  const runtime = await waitForNdrRuntime()
  if (getPubkey() !== owner) return
  const event = {
    kind: CHAT_MUTE_KIND,
    pubkey: owner,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', owner]],
    content: JSON.stringify({ type: 'chat-mute', v: 1, mute }),
  }
  // Address the account itself; the runtime queues only its sibling devices.
  await runtime.sendEvent(owner, { ...event, id: getEventHash(event) })
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
