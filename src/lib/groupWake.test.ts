// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { Group, Session, InMemoryStorageAdapter, serializeSessionState, deserializeSessionState, type NdrRuntime } from 'nostr-double-ratchet'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools'
import { GROUP_WAKE_KIND, groupWakeRumor, parseGroupWake } from './groupWake'
import { createGroupWakeQueue } from './groupWakeQueue'

const key = (n: number) => new Uint8Array(32).fill(n)

it('delivers the same signed group event through distinct private sessions, including after restart', async () => {
  const owner = getPublicKey(key(1)), other = getPublicKey(key(2)), sibling = getPublicKey(key(3))
  const data = {id:'private-group',name:'Friends',members:[owner,other,sibling],admins:[owner],createdAt:100}
  const group = new Group({data,ourOwnerPubkey:owner,ourDevicePubkey:getPublicKey(key(4))})
  const sent = await group.sendMessage('hello', {sendPairwise:async()=>{},publishOuter:async()=>{}})
  const wires: Event[] = []
  const sessions = new Map([owner,other,sibling].map((recipient,i) => {
    const a = key(10+i), b = key(20+i), shared = key(30+i)
    return [recipient, {
      send:Session.init(getPublicKey(b),a,true,shared),
      receive:Session.init(getPublicKey(a),b,false,shared),
    }]
  }))
  const sendEvent = vi.fn(async (...[recipient,rumor,_owner,options]: Parameters<NdrRuntime['sendEvent']>) => {
    expect(options).toEqual({includeLocalSiblings:false})
    const pair = sessions.get(recipient)!
    const wire = pair.send.sendEvent(rumor).event
    wires.push(wire)
    // Persisted state, rather than the original object, handles the first delivery.
    const restored = new Session(deserializeSessionState(serializeSessionState(pair.receive.state)))
    const received = restored.receiveEvent(wire)!
    expect(JSON.stringify(parseGroupWake(received))).toBe(JSON.stringify(sent.outer))
    return received
  })
  const queue=createGroupWakeQueue({
    owner,storage:new InMemoryStorageAdapter(),runtime:()=>({sendEvent}),
    active:()=>true,group:async()=>({...data,members:[...data.members,other]}),
    localSender:async()=>sent.outer.pubkey,onError:error=>{throw error},
  })
  await queue.enqueue(sent.outer,{groupId:data.id})
  await queue.retry()
  queue.close()
  expect(sendEvent).toHaveBeenCalledTimes(3)
  expect(new Set(wires.map(event=>event.pubkey)).size).toBe(3)
  for (const wire of wires) {
    const serialized = JSON.stringify(wire)
    for (const hidden of [owner,other,sibling,getPublicKey(key(4)),sent.outer.pubkey,data.id,sent.outer.id]) {
      expect(serialized).not.toContain(hidden)
    }
    expect(wire.kind).toBe(1060)
    expect(wire.tags.map(tag=>tag[0])).toEqual(['v','header'])
  }
})

it('rejects unsigned, obsolete and substituted group envelopes', () => {
  const valid = finalizeEvent({kind:1060,created_at:100,content:'ciphertext',tags:[['v','2']]},key(2))
  const rumor = groupWakeRumor(valid)
  expect(rumor.kind).toBe(GROUP_WAKE_KIND)
  expect(rumor.tags).toEqual([])
  expect(parseGroupWake(rumor)).toEqual(valid)
  for(const event of [
    {...valid,content:'substituted'},
    finalizeEvent({kind:1060,created_at:100,content:'legacy',tags:[]},key(2)),
    finalizeEvent({kind:1,created_at:100,content:'public',tags:[['v','2']]},key(2)),
  ]) {
    expect(parseGroupWake({kind:GROUP_WAKE_KIND,content:JSON.stringify({v:1,type:'group-wake',event})})).toBeUndefined()
    expect(()=>groupWakeRumor(event)).toThrow()
  }
})
