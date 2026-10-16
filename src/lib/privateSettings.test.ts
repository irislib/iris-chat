import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { buildPrivateSetting } from 'nostr-social-graph/privateEvents'
import { db, applyHistoryChatDeletion, chatDeletionStates, admitHistoryMessage } from './storage'
import { privateSettingEvents, privateSettingSnapshot } from './privateSettings'
import { deviceSyncRecordId } from './deviceSyncRecords'
import { encodeDeviceSyncPacket, parseDeviceSyncPacket } from './deviceSyncProtocol'
const owner = 'a'.repeat(64), first = 'b'.repeat(64), second = 'c'.repeat(64)
beforeEach(async () => { await db.messages.clear(); await db.sessions.clear(); await db.groups.clear(); await db.sessionManager.clear() })
it.each([false,true])('merges concurrent offline chat deletions independently, reverses delivery=%s', async (reverse: boolean) => {
  const records = [first, second].map(id => ({ type: 'privateEvent' as const, event: buildPrivateSetting(owner, 'chatDeletion', id, { id, deletedAt: 100 }) }))
  expect(new Set(records.map(deviceSyncRecordId)).size).toBe(2)
  const packet = parseDeviceSyncPacket(encodeDeviceSyncPacket({ v: 1, type: 'historyRecords', session: '1'.repeat(32), records, requested: [] }), owner)
  if (packet.type !== 'historyRecords') throw new Error('Wrong packet')
  for (const record of reverse ? packet.records.reverse() : packet.records) {
    if (record.type !== 'privateEvent') throw new Error('Wrong record')
    const deletion = privateSettingSnapshot(record.event, owner).deletedChats![0]
    await applyHistoryChatDeletion(deletion.id, deletion.deletedAt)
  }
  db.close(); await db.open()
  expect((await chatDeletionStates()).sort((a,b) => a.id.localeCompare(b.id))).toEqual([{id:first,deletedAt:100},{id:second,deletedAt:100}])
  for (const sessionId of [first, second]) {
    expect(await admitHistoryMessage({ id: sessionId, sessionId, timestamp: 100000, content: 'old', isMine: false })).toBe(false)
    expect(await admitHistoryMessage({ id: `new-${sessionId}`, sessionId, timestamp: 101000, content: 'new', isMine: false })).toBe(true)
  }
})
it('merges duplicate and older deletions without deleting a reopened chat or its newer messages', async () => {
  await db.sessions.put({id:first,recipientPubkey:first,createdAt:201000,mode:'manager'})
  await db.messages.bulkPut([100,150,201].map(time => ({id:String(time),sessionId:first,timestamp:time*1000,content:'x',isMine:false})))
  for (const cutoff of [150,100,150]) await applyHistoryChatDeletion(first,cutoff)
  expect(await chatDeletionStates()).toEqual([{id:first,deletedAt:150}])
  expect((await db.messages.toArray()).map(message=>message.id)).toEqual(['201'])
  expect(await db.sessions.get(first)).toBeDefined()
  await expect(applyHistoryChatDeletion(second,150,()=>false)).rejects.toThrow()
  expect(await chatDeletionStates()).toHaveLength(1)
})
it('reads native deletion batches and rejects malformed or future cutoffs', () => {
  const packet = { v:1 as const, type:'snapshot' as const, rosterAt:0, appKeys:[], chats:[], groups:[], messages:[], deletedChats:[{id:first,deletedAt:100},{id:second,deletedAt:101}] }
  expect(parseDeviceSyncPacket(encodeDeviceSyncPacket(packet),owner)).toEqual(packet)
  for (const deletedAt of [-1, Date.now()/1000+1000]) expect(()=>parseDeviceSyncPacket(encodeDeviceSyncPacket({...packet,deletedChats:[{id:first,deletedAt}]}),owner)).toThrow()
})
it('merges request decisions per chat, retains explicit clears and isolates accounts', async () => {
  const { loadMessageRequestDecisions, mergeRequestDecision, requestDecisionStates, clearMessageRequestDecisions } = await import('./messageRequests')
  localStorage.clear()
  clearMessageRequestDecisions()
  loadMessageRequestDecisions(owner)
  for (const value of [
    { chatId:first,decision:'accepted' as const,updatedAtMs:1000 },
    { chatId:second,decision:'rejected' as const,updatedAtMs:1000 },
    { chatId:first,decision:'none' as const,updatedAtMs:1001 },
    { chatId:first,decision:'accepted' as const,updatedAtMs:1000 },
  ]) {
    const event = buildPrivateSetting(owner,'requestDecision',value.chatId,value)
    mergeRequestDecision(owner,privateSettingSnapshot(event,owner).requestDecisions![0])
  }
  const states = requestDecisionStates(owner)
  expect(states).toEqual([{chatId:first,decision:'none',updatedAtMs:1001},{chatId:second,decision:'rejected',updatedAtMs:1000}])
  clearMessageRequestDecisions(); loadMessageRequestDecisions(owner)
  expect(requestDecisionStates(owner)).toEqual(states)
  loadMessageRequestDecisions(second)
  expect(requestDecisionStates(second)).toEqual([])
  expect(()=>mergeRequestDecision(owner,states[0])).toThrow()
})

it('exports inferred acceptance as a private state event after restart and message expiry', async () => {
  const { loadMessageRequestDecisions, clearMessageRequestDecisions, acceptChatFromActivity, requestDecisionStates } = await import('./messageRequests')
  localStorage.clear(); clearMessageRequestDecisions(); loadMessageRequestDecisions(owner)
  acceptChatFromActivity(owner, first, 123456)
  clearMessageRequestDecisions(); loadMessageRequestDecisions(owner)
  const events = []
  for await (const event of privateSettingEvents(owner, [])) {
    const packet = privateSettingSnapshot(event, owner)
    if (packet.requestDecisions) events.push(...packet.requestDecisions)
  }
  expect(events).toEqual(requestDecisionStates(owner))
  expect(events).toEqual([{ chatId: first, decision: 'accepted', updatedAtMs: 123456 }])
})
