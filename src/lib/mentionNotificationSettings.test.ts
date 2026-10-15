import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import { buildPrivateSetting } from 'nostr-social-graph/privateEvents'
import { db } from './storage'
import { privateSettingEvents, privateSettingSnapshot } from './privateSettings'
import { createDeviceSyncRecordAdapter } from './deviceSyncRecordAdapter'
import { mentionSetting, mentionSettingKey, shouldNotifyMutedMessage, subscriptionMutes } from './mentionNotificationPolicy'
import { formatMention } from './mentions'
import { encodeDeviceSyncPacket, parseDeviceSyncPacket } from './deviceSyncProtocol'
vi.mock('./notifications',()=>({updateDMSubscription:vi.fn()}))
const owner = 'a'.repeat(64), chatId = 'group:friends'
const event = (enabled: boolean, updatedAtMs = 100) => buildPrivateSetting(owner,'mentionNotifications',chatId,{chatId,enabled,updatedAtMs})
const snapshot = {v:1 as const,type:'snapshot' as const,rosterAt:0,chats:[],groups:[],messages:[],appKeys:[]}
it('matches the native unsigned private setting golden event',()=>{expect(event(false).id).toBe('22d008e761842325621971056bf74830903da752ac5041af1b76db8b181a6e3d')})
beforeEach(async()=>{await db.sessionManager.clear();await db.messages.clear();await db.groups.clear()})
it('imports native-compatible private event records through the production adapter without chat history and survives restart', async()=>{
  const adapter = createDeviceSyncRecordAdapter({owner,snapshots:()=>[snapshot],messages:()=>[],allowsLegacy:()=>false,applySnapshot:async()=>0})
  const packet = parseDeviceSyncPacket(encodeDeviceSyncPacket({v:1,type:'historyRecords',session:'1'.repeat(32),records:[{type:'privateEvent',event:event(false)}],requested:[]}),owner)
  if (packet.type !== 'historyRecords') throw Error('Wrong packet')
  await adapter.applyRecords('peer',packet.records,'state',0,0,undefined,()=>true)
  db.close();await db.open()
  expect(mentionSetting((await db.sessionManager.get(mentionSettingKey(owner,chatId)))!.value as ReturnType<typeof event>,owner).enabled).toBe(false)
  const exported=[];for await (const value of privateSettingEvents(owner,[snapshot])) exported.push(value)
  expect(exported).toContainEqual(event(false))
  for (const incoming of [event(true,99),event(true,100)]) await adapter.applyRecords('peer',[{type:'privateEvent',event:incoming}],'state',0,0,undefined,()=>true)
  expect((await db.sessionManager.get(mentionSettingKey(owner,chatId)))?.value).toEqual(event(false))
  await adapter.applyRecords('peer',[{type:'privateEvent',event:event(true,101)}],'state',0,0,undefined,()=>true)
  expect((await db.sessionManager.get(mentionSettingKey(owner,chatId)))?.value).toEqual(event(true,101))
})
it('rejects malformed, future, foreign and unauthorized private settings',async()=>{
  for (const value of [{chatId,enabled:false,updatedAtMs:0},{chatId,enabled:false,updatedAtMs:Date.now()+600000},{chatId:'group:other',enabled:false,updatedAtMs:1},{chatId,enabled:0,updatedAtMs:1}]) expect(()=>privateSettingSnapshot(buildPrivateSetting(owner,'mentionNotifications',chatId,value),owner)).toThrow()
  expect(()=>privateSettingSnapshot(event(false),'b'.repeat(64))).toThrow()
})
it('subscribes groups for locally verified mentions; mute opt-out, direct mutes and quoted mentions remain quiet',()=>{
  const mutes = {[chatId]:0,['b'.repeat(64)]:0}, mention = formatMention(owner,'Alice')
  expect(subscriptionMutes(mutes,{},true)).toEqual({['b'.repeat(64)]:0})
  expect(subscriptionMutes(mutes,{[chatId]:{chatId,enabled:false,updatedAtMs:1}},true)).toEqual(mutes)
  expect(shouldNotifyMutedMessage(mutes,chatId,mention,owner)).toBe(true)
  for(const text of ['Hi @Alice','hello',formatMention('b'.repeat(64),'Alice'),`Forwarded:\n${mention}`,`↩ Bob: ${mention}\n\nThanks`]) expect(shouldNotifyMutedMessage(mutes,chatId,text,owner)).toBe(false)
  expect(shouldNotifyMutedMessage(mutes,chatId,mention,owner,false)).toBe(false)
  expect(shouldNotifyMutedMessage(mutes,'b'.repeat(64),mention,owner)).toBe(false)
})
it('Negentropy state reconciliation transfers the private setting with no chat or history',async()=>{
  const {DeviceHistorySync}=await import('./deviceHistorySync')
  const {deviceSyncRecordId}=await import('./deviceSyncRecords')
  const adapter=createDeviceSyncRecordAdapter({owner,snapshots:()=>[snapshot],messages:()=>[],allowsLegacy:()=>false,applySnapshot:async()=>0})
  const record={type:'privateEvent' as const,event:event(false)}
  const queue:Array<{to:number;packet:import('./deviceSyncProtocol').DeviceHistoryPacket}>=[]
  const send=(to:number)=>async(_peer:string,packet:import('./deviceSyncProtocol').DeviceHistoryPacket)=>{queue.push({to,packet:parseDeviceSyncPacket(encodeDeviceSyncPacket(packet),owner) as typeof packet})}
  const receiver=new DeviceHistorySync({authorized:()=>true,recordInventory:adapter.recordInventory,records:adapter.records,
    applyRecords:(peer,records,scope,since,until,link)=>adapter.applyRecords(peer,records,scope,since,until,link,()=>true),send:send(1)})
  const sender=new DeviceHistorySync({authorized:()=>true,
    recordInventory:async(scope,_since,_until,_initiator,prefix)=>scope==='state'&&record.event.id.startsWith(prefix) ? [{id:deviceSyncRecordId(record),createdAt:0}] : [],
    records:async(_scope,_since,_until,refs)=>refs.some(ref=>ref.id===record.event.id)?[record]:[],applyRecords:async()=>0,send:send(0)})
  receiver.negotiate('sender',0,{privateEvents:2});sender.negotiate('receiver',0,{privateEvents:2})
  await receiver.startState('sender')
  for(let rounds=0;queue.length;rounds++) {expect(rounds).toBeLessThan(100);const next=queue.shift()!;await (next.to ? sender:receiver).receive(next.to?'receiver':'sender',next.packet)}
  expect((await db.sessionManager.get(mentionSettingKey(owner,chatId)))?.value).toEqual(record.event)
})
