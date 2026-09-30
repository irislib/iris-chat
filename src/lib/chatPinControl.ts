import { get } from 'svelte/store'
import { getEventHash } from 'nostr-tools'
import type { OnEventMeta, Rumor } from 'nostr-double-ratchet'
import { devices } from './devices'
import { getPubkey } from './identity'
import { waitForNdrRuntime } from './privateChats'
import { CHAT_PIN_KIND, isChatPinState, type ChatPinState } from './chatPinSync'
import { mergeChatPins } from './chatPinStore'

export async function sendChatPinControl(owner: string, pin: ChatPinState): Promise<void> {
  const runtime = await waitForNdrRuntime()
  if (getPubkey() !== owner) return
  const event = {
    kind: CHAT_PIN_KIND,
    pubkey: owner,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', owner]],
    content: JSON.stringify({ type: 'chat-pin', v: 1, pin }),
  }
  // Address the account itself; the runtime queues only its sibling devices.
  await runtime.sendEvent(owner, { ...event, id: getEventHash(event) })
}

export async function receiveChatPinControl(rumor: Rumor, meta?: OnEventMeta): Promise<void> {
  const owner = getPubkey()
  const state = get(devices)
  const sender = meta?.senderDevicePubkey || meta?.fromDeviceId
  if (!owner || meta?.senderOwnerPubkey !== owner || !sender ||
    sender === state.identityPubkey || !state.isCurrentDeviceRegistered ||
    !state.registeredDevices.some(device => device.identityPubkey === sender) ||
    (rumor.pubkey !== owner && rumor.pubkey !== sender)) return
  let value
  try { value = JSON.parse(rumor.content) } catch { return }
  if (value?.type !== 'chat-pin' || value.v !== 1 || !isChatPinState(value.pin)) return
  await mergeChatPins([value.pin], owner)
}
