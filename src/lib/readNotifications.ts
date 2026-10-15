import { readState } from './privateStateStore'
import { db } from './storage'
export interface NotificationMessage { ownerPubkey: string; chatId: string; messageId: string; createdAtSecs: number }
type Registration = Pick<ServiceWorkerRegistration,'getNotifications' | 'showNotification'>
const matches = (data: unknown, message: NotificationMessage) => !!data && typeof data === 'object' &&
  Object.entries(message).every(([key,value]) => (data as Record<string,unknown>)[key] === value)
async function registration(): Promise<Registration | undefined> {
  if (typeof self !== 'undefined' && 'registration' in self) return (self as unknown as {registration:Registration}).registration
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.getRegistration) return navigator.serviceWorker.getRegistration()
}
export async function dismissReadNotification(message: NotificationMessage, target?: Registration): Promise<void> {
  const reg = target ?? await registration()
  if (!reg?.getNotifications) return
  const notifications = await reg.getNotifications()
  for (const notification of notifications) if (matches(notification.data,message)) notification.close()
}
async function isRead(message: NotificationMessage) {
  return (await readState(message.ownerPubkey,message.chatId,message.messageId))?.createdAtSecs === message.createdAtSecs
}
/** Both sides of showNotification are checked: a read can race its async enqueue. */
export async function showUnreadNotification(reg: Registration, message: NotificationMessage, title: string, options: NotificationOptions): Promise<void> {
  const post = async () => {
    const active = async () => (await db.sessionManager.get('v1/device-manager/owner-pubkey'))?.value === message.ownerPubkey
    if (!await active() || await isRead(message)) return
    if ((await reg.getNotifications()).some(notification => matches(notification.data,message))) return
    await reg.showNotification(title,{...options,data:message})
    if (!await active() || await isRead(message)) await dismissReadNotification(message,reg)
  }
  // Relay delivery and Web Push may arrive together in separate execution contexts.
  if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(`iris-notification:${JSON.stringify(message)}`,post)
  else await post()
}
