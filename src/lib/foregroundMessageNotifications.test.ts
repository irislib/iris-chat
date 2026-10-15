import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'
import { getEventHash } from 'nostr-tools'
import { nhashEncode } from '@hashtree/core'
vi.mock('./identity',()=>({identity:writable({pubkey:'a'.repeat(64)})}))
vi.mock('./chat',()=>({currentChat:writable(null),chats:writable(new Map([['b'.repeat(64),{id:'b'.repeat(64),recipientPubkey:'b'.repeat(64),messages:[]}]]))}))
const policy=vi.hoisted(()=>({accepted:false,rejected:false}))
vi.mock('./messageRequestPolicy',()=>({getMessageRequestPolicyContext:()=>({}),isChatAccepted:()=>policy.accepted,isChatRejected:()=>policy.rejected}))
vi.mock('./groups',()=>({currentGroupId:writable(null),groups:writable(new Map([['friends',{name:'Friends',members:['a'.repeat(64),'b'.repeat(64)]}]]))}))
vi.mock('./mentionNames',()=>({mentionNames:()=>writable({['b'.repeat(64)]:'Bob'})}))
vi.mock('./notifications',()=>({updateDMSubscription:vi.fn()}))
import { notifyForegroundMessage } from './foregroundMessageNotifications'
import { notificationSettings } from './notificationStore'
import { chatMutes,loadChatMutes } from './chatMuteStore'
import { mentionNotificationSettings } from './mentionNotificationSettings'
import { db } from './storage'
import { formatMention } from './mentions'
const owner='a'.repeat(64),chatId='group:friends'
const showNotification=vi.fn(async()=>{})
beforeEach(async()=>{
  await db.messages.clear();await db.sessionManager.clear();await db.groups.clear();showNotification.mockClear();policy.accepted=false;policy.rejected=false
  await db.groups.put({id:'friends',name:'Friends',members:[owner,'b'.repeat(64)],admins:[owner],createdAt:1})
  await db.sessionManager.put({key:'v1/device-manager/owner-pubkey',value:owner})
  await loadChatMutes(owner);chatMutes.set({[chatId]:0});mentionNotificationSettings.set({})
  notificationSettings.setEnabled(true)
  vi.stubGlobal('Notification',{permission:'granted'})
  vi.stubGlobal('navigator',{serviceWorker:{getRegistration:async()=>({showNotification,getNotifications:async()=>[]})}})
})
it('active runtime applies the muted mention exception with concise attachment previews and opt-out',async()=>{
  const message={id:'id',sessionId:chatId,content:'ordinary',timestamp:100000,isMine:false,senderPubkey:'b'.repeat(64)}
  await notifyForegroundMessage(owner,message);expect(showNotification).not.toHaveBeenCalled()
  message.content=`${formatMention(owner,'Alice')} caption ${nhashEncode({hash:new Uint8Array(32).fill(1)})}`
  await notifyForegroundMessage(owner,message)
  expect(showNotification).toHaveBeenCalledWith('Friends',expect.objectContaining({body:'@Alice caption Attachment',data:{ownerPubkey:owner,chatId,messageId:'id',createdAtSecs:100}}))
  showNotification.mockClear();mentionNotificationSettings.set({[chatId]:{chatId,enabled:false,updatedAtMs:100}})
  await notifyForegroundMessage(owner,message);expect(showNotification).not.toHaveBeenCalled()
})

it('rejects pending and removed groups, expired/deleted messages and private block history before showing a mention',async()=>{
  const peer='b'.repeat(64)
  const message={id:'guarded',sessionId:chatId,content:formatMention(owner,'Alice'),timestamp:100000,isMine:false,senderPubkey:peer}
  const quiet=async(patch:Partial<typeof message> & {expiresAt?:number;deletedAt?:number}={})=>{
    await notifyForegroundMessage(owner,{...message,...patch});expect(showNotification).not.toHaveBeenCalled()
  }
  await quiet({expiresAt:99});await quiet({deletedAt:101})
  await db.messages.put({...message,deletedAt:101});await quiet();await db.messages.clear()
  await db.sessionManager.put({key:'history-deleted-message:guarded',value:{}});await quiet();await db.sessionManager.delete('history-deleted-message:guarded')
  await db.sessionManager.put({key:`history-deleted-chat:${chatId}`,value:101});await quiet();await db.sessionManager.delete(`history-deleted-chat:${chatId}`)
  await db.groups.update('friends',{accepted:false});await quiet()
  await db.groups.update('friends',{accepted:true,members:[peer]});await quiet()
  await db.groups.update('friends',{members:[owner]});await quiet()
  await db.groups.update('friends',{members:[owner,peer]})
  const block=(blocked:boolean,revision:number,time:number)=>{
    const event={pubkey:owner,created_at:time,kind:10454,tags:[['p',owner],['d',`iris:block:${peer}`]],content:JSON.stringify({v:1,owner,target:peer,blocked,revision,blockedSince:90,deletedAt:0})}
    return {...event,id:getEventHash(event)}
  }
  for(const event of [block(true,1,90),block(false,2,110)]) {
    await db.sessionManager.put({key:`private-state-v1:${owner}:event:10454:${peer}:${event.id}`,value:event})
    await quiet()
  }
  // A message after the completed block interval is admitted again.
  await notifyForegroundMessage(owner,{...message,timestamp:111000})
  expect(showNotification).toHaveBeenCalledOnce()
})
it('does not notify unaccepted or rejected direct requests',async()=>{
  chatMutes.set({})
  const message={id:'direct',sessionId:'b'.repeat(64),content:'hello',timestamp:100000,isMine:false}
  await notifyForegroundMessage(owner,message);expect(showNotification).not.toHaveBeenCalled()
  policy.accepted=true;policy.rejected=true
  await notifyForegroundMessage(owner,message);expect(showNotification).not.toHaveBeenCalled()
  policy.rejected=false
  await notifyForegroundMessage(owner,message);expect(showNotification).toHaveBeenCalledOnce()
})
