// @vitest-environment node
import 'fake-indexeddb/auto'
import { beforeAll,beforeEach,expect,it,vi } from 'vitest'
import { AppKeys,Group,InMemoryStorageAdapter,Session,serializeSessionState } from 'nostr-double-ratchet'
import { getPublicKey,type Event } from 'nostr-tools'
import { nhashEncode } from '@hashtree/core'
import { groupPushChannels } from './lib/groupPush'
import { db } from './lib/storage'
import { formatMention } from './lib/mentions'
import { chatMutesKey } from './lib/chatMutePolicy'
import { readState } from './lib/privateStateStore'
import { mentionSettingKey } from './lib/mentionNotificationPolicy'
import { buildPrivateSetting } from 'nostr-social-graph/privateEvents'
const key=(n:number)=>new Uint8Array(32).fill(n)
const owner=getPublicKey(key(1)),peer=getPublicKey(key(2)),device=getPublicKey(key(3))
const handlers=new Map<string,(event:unknown)=>void>()
let notices:Array<{data:Record<string,unknown>;close:ReturnType<typeof vi.fn>}> = []
const showNotification=vi.fn(async(_title:string,options:NotificationOptions)=>{notices.push({data:options.data,close:vi.fn()})})
beforeAll(async()=>{
  vi.stubGlobal('self',{registration:{scope:'https://chat.invalid/',showNotification,getNotifications:async()=>notices},clients:{matchAll:async()=>[]},addEventListener:(type:string,handler:(event:unknown)=>void)=>handlers.set(type,handler)})
  await import('./service-worker')
})
beforeEach(async()=>{
  await Promise.all([db.messages.clear(),db.sessionManager.clear(),db.processedEvents.clear(),db.groups.clear(),db.sessions.clear(),db.pendingPushEvents.clear()])
  await db.sessionManager.put({key:'v1/device-manager/owner-pubkey',value:owner})
  showNotification.mockClear();notices=[]
})
async function push(event:Event){let work:Promise<void>|undefined;handlers.get('push')!({data:{json:()=>({event})},waitUntil:(promise:Promise<void>)=>{work=promise}});await work}
it('decrypts real group ciphertext over a disposable snapshot, mentions only, opt-out and concise attachments',async()=>{
  const data={id:'friends',name:'Friends',members:[owner,peer],admins:[owner],createdAt:100}
  await db.groups.put(data)
  const storage=new InMemoryStorageAdapter()
  const receiver=new Group({data,ourOwnerPubkey:owner,ourDevicePubkey:owner,storage})
  const sender=new Group({data,ourOwnerPubkey:peer,ourDevicePubkey:device})
  const sendPairwise=async(to:string,rumor:Parameters<typeof receiver.handleIncomingSessionEvent>[0])=>{if(to===owner) await receiver.handleIncomingSessionEvent(rumor,peer,device)}
  const plain=await sender.sendMessage('ordinary',{sendPairwise,publishOuter:async()=>{}})
  for(const k of await storage.list()) await db.sessionManager.put({key:k,value:await storage.get(k)})
  await db.sessionManager.put({key:chatMutesKey(owner),value:{'group:friends':0}})
  // Our own sender channel must not cause visible-only pushes on linked devices.
  await receiver.sendMessage('own',{sendPairwise:async()=>{},publishOuter:async()=>{}})
  for(const k of await storage.list()) await db.sessionManager.put({key:k,value:await storage.get(k)})
  const [channel]=await groupPushChannels(owner)
  expect(channel.authors.length).toBeGreaterThan(channel.subscriptionAuthors.length)
  expect(channel.subscriptionAuthors).toContain(plain.outer.pubkey)
  const before=await db.sessionManager.toArray()
  await push(plain.outer);expect(showNotification).not.toHaveBeenCalled()
  const hash=nhashEncode({hash:key(1)})
  const mentioned=await sender.sendMessage(`${formatMention(owner,'Alice')} ${hash}`,{sendPairwise,publishOuter:async()=>{}})
  await push(mentioned.outer)
  expect(showNotification).toHaveBeenCalledOnce()
  expect(showNotification.mock.calls[0][1]).toMatchObject({body:'@Alice Attachment',data:{ownerPubkey:owner,chatId:'group:friends',messageId:mentioned.inner.id}})
  expect(await db.sessionManager.toArray()).toEqual(before)
  showNotification.mockClear()
  await db.messages.put({id:mentioned.inner.id,sessionId:'group:friends',content:mentioned.inner.content,timestamp:mentioned.inner.created_at*1000,isMine:false,deletedAt:Date.now()})
  await push(mentioned.outer);expect(showNotification).not.toHaveBeenCalled()
  await db.messages.delete(mentioned.inner.id)
  await db.groups.update('friends',{accepted:false})
  await push(mentioned.outer);expect(showNotification).not.toHaveBeenCalled()
  await db.groups.update('friends',{accepted:true})
  await db.sessionManager.put({key:mentionSettingKey(owner,'group:friends'),value:buildPrivateSetting(owner,'mentionNotifications','group:friends',{chatId:'group:friends',enabled:false,updatedAtMs:100})})
  showNotification.mockClear();await push(mentioned.outer);expect(showNotification).not.toHaveBeenCalled()
  await db.groups.update('friends',{members:[peer]})
  await push(mentioned.outer);expect(showNotification).not.toHaveBeenCalled()
})
it('authenticates an own-device read in the worker without a page, leaves other alerts and ratchet state intact',async()=>{
  const sender=Session.init(getPublicKey(key(5)),key(4),true,key(6))
  const receiver=Session.init(getPublicKey(key(4)),key(5),false,key(6))
  const state=serializeSessionState(receiver.state)
  const roster=new AppKeys();roster.addDevice({identityPubkey:device,createdAt:100})
  const record={publicKey:owner,appKeys:roster.serialize(),devices:[{deviceId:device,activeSession:{name:'test',state},inactiveSessions:[],createdAt:100}]}
  await db.sessionManager.put({key:`v1/user/${owner}`,value:record})
  notices=[{ownerPubkey:owner,chatId:peer,messageId:'seen',createdAtSecs:100},{ownerPubkey:owner,chatId:peer,messageId:'unread',createdAtSecs:100}].map(data=>({data,close:vi.fn()}))
  const event=sender.sendEvent({kind:15,pubkey:owner,content:'seen',tags:[['p',peer],['e','seen'],['iris-read-state',JSON.stringify({seenMessages:{seen:{createdAtSecs:100}}})]]}).event
  await push(event)
  expect(await readState(owner,peer,'seen')).toEqual({createdAtSecs:100})
  expect(notices.map(n=>n.close.mock.calls.length)).toEqual([1,0])
  expect(showNotification).not.toHaveBeenCalled()
  expect((await db.sessionManager.get(`v1/user/${owner}`))?.value).toEqual(record)
  roster.removeDevice(device)
  await db.sessionManager.put({key:`v1/user/${owner}`,value:{...record,appKeys:roster.serialize()}})
  const forged=sender.sendEvent({kind:15,pubkey:owner,content:'seen',tags:[['p',peer],['iris-read-state',JSON.stringify({seenMessages:{unread:{createdAtSecs:100}}})]]}).event
  await push(forged)
  expect(await readState(owner,peer,'unread')).toBeUndefined()
})

it('uses the authenticated pairwise owner rather than an inner author claim for group admission',async()=>{
  const sender=Session.init(getPublicKey(key(5)),key(4),true,key(6))
  const receiver=Session.init(getPublicKey(key(4)),key(5),false,key(6))
  await db.sessionManager.put({key:`v1/user/${peer}`,value:{publicKey:peer,devices:[{deviceId:device,activeSession:{name:'test',state:serializeSessionState(receiver.state)},inactiveSessions:[],createdAt:100}]}})
  // The peer is not a member, even though its encrypted rumor claims a member.
  await db.groups.put({id:'private',name:'Private',members:[owner,device],admins:[owner],createdAt:100})
  await push(sender.sendEvent({kind:14,pubkey:device,content:'spoof',tags:[['l','private']]}).event)
  expect(showNotification).not.toHaveBeenCalled()
})
