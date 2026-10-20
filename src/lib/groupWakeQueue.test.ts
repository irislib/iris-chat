import { expect, it, vi } from 'vitest'
import { InMemoryStorageAdapter, type NdrRuntime, type Rumor } from 'nostr-double-ratchet'
import { finalizeEvent, generateSecretKey, getEventHash } from 'nostr-tools'
import { createGroupWakeQueue } from './groupWakeQueue'
import { parseGroupWake } from './groupWake'

const OWNER='a'.repeat(64)
const PEER='b'.repeat(64)

it('persists private delivery before publication and resumes only unfinished members after a restart',async()=>{
  const storage=new InMemoryStorageAdapter()
  const event=finalizeEvent({kind:1060,created_at:1,content:'group ciphertext',tags:[['v','2']]},generateSecretKey())
  let online=false
  const sent:string[]=[]
  const sendEvent: NdrRuntime['sendEvent']=async(member,rumor)=>{
    if (member===PEER && !online) throw new Error('temporary failure')
    expect(JSON.stringify(parseGroupWake(rumor as never))).toBe(JSON.stringify(event))
    sent.push(member)
    return undefined
  }
  const options={owner:OWNER,storage,runtime:()=>({sendEvent}),active:()=>true,onError:vi.fn(),
    group:async()=>({id:'group',name:'Friends',members:[OWNER,PEER],admins:[OWNER],createdAt:1}),
    localSender:async()=>event.pubkey}
  const queue=createGroupWakeQueue(options)
  await queue.enqueue(event,{groupId:'group'})
  expect(sent).toEqual([])
  await queue.retry()
  expect(sent).toEqual([OWNER])
  queue.close()
  online=true
  const restarted=createGroupWakeQueue(options)
  await restarted.retry()
  expect(sent).toEqual([OWNER,PEER])
  await restarted.enqueue(event,{groupId:'group'})
  await restarted.retry()
  expect(sent).toEqual([OWNER,PEER])
  expect((await storage.list('iris-group-wakes:v1:')).length).toBe(0)
  restarted.close()
})

it('never queues pairwise key distributions or sends retained jobs after group removal',async()=>{
  const storage=new InMemoryStorageAdapter()
  const event=finalizeEvent({kind:1060,created_at:1,content:'group ciphertext',tags:[['v','2']]},generateSecretKey())
  let members=[OWNER,PEER]
  const sendEvent=vi.fn<NdrRuntime['sendEvent']>(async()=>undefined)
  const queue=createGroupWakeQueue({owner:OWNER,storage,runtime:()=>({sendEvent}),active:()=>true,onError:vi.fn(),
    group:async()=>({id:'group',name:'Friends',members,admins:[OWNER],createdAt:1}),
    localSender:async()=>event.pubkey})
  await queue.enqueue(finalizeEvent({kind:1060,created_at:1,content:'pairwise',tags:[['v','2']]},generateSecretKey()),{groupId:'group'})
  expect(await storage.list()).toEqual([])
  await queue.enqueue(event,{groupId:'group'})
  members=[PEER]
  await queue.retry()
  expect(sendEvent).not.toHaveBeenCalled()
  queue.close()
})

it('fails closed before the publication handoff while inactive and retires blocked recipient work',async()=>{
  const storage=new InMemoryStorageAdapter()
  const event=finalizeEvent({kind:1060,created_at:1,content:'group ciphertext',tags:[['v','2']]},generateSecretKey())
  let active=false
  const sendEvent=vi.fn<NdrRuntime['sendEvent']>(async()=>undefined)
  const queue=createGroupWakeQueue({owner:OWNER,storage,runtime:()=>({sendEvent}),active:()=>active,onError:vi.fn(),
    group:async()=>({id:'group',name:'Friends',members:[OWNER,PEER],admins:[OWNER],createdAt:1}),
    localSender:async()=>event.pubkey,canSend:async member=>member!==PEER})
  await expect(queue.enqueue(event,{groupId:'group'})).rejects.toThrow('not ready')
  expect(await storage.list()).toEqual([])
  active=true
  await queue.enqueue(event,{groupId:'group'})
  await queue.retry()
  expect(sendEvent.mock.calls.map((call:Parameters<NdrRuntime['sendEvent']>)=>call[0])).toEqual([OWNER])
  expect(await storage.list('iris-group-wakes:v1:')).toEqual([])
  queue.close()
})

it('retains unknown group and held recipients, with distinct durable IDs and both publication policies',async()=>{
  const storage=new InMemoryStorageAdapter()
  const senderKey=generateSecretKey()
  const first=finalizeEvent({kind:1060,created_at:1,content:'first',tags:[['v','2']]},senderKey)
  const second=finalizeEvent({kind:1060,created_at:2,content:'second',tags:[['v','2']]},senderKey)
  let known=true, held=true
  const sent:Rumor[]=[]
  const queue=createGroupWakeQueue({owner:OWNER,storage,active:()=>true,onError:vi.fn(),
    localSender:async()=>first.pubkey,
    group:async()=>known ? {id:'group',name:'Friends',members:[OWNER,PEER],admins:[OWNER],createdAt:1} : undefined,
    canSend:async()=>held ? 'hold' : true,
    runtime:()=>({sendEvent:async(_member,event)=>{
      const rumor=event as Rumor
      expect(rumor.id).toBe(getEventHash(rumor))
      await storage.put(`v1/message-queue/${rumor.id}/device`,{event:rumor})
      sent.push(rumor)
      expect(await queue.publicationContext(rumor.id,{groupId:'group'})).toEqual({
        groupId:'group',recipientOwnerPubkey:rumor.tags.find(tag=>tag[0]==='p')![1],createdAt:rumor.created_at,
      })
      return rumor
    }})})
  await queue.enqueue(first,{groupId:'group'})
  await queue.enqueue(second,{groupId:'group'})
  await queue.retry()
  expect(sent).toEqual([])
  expect(await storage.list('iris-group-wakes:v1:')).toHaveLength(2)
  held=false;known=false
  await queue.retry()
  expect(sent).toEqual([])
  known=true
  await queue.retry()
  expect(sent).toHaveLength(4)
  expect(new Set(sent.map(rumor=>rumor.id)).size).toBe(4)
  queue.close()
})
