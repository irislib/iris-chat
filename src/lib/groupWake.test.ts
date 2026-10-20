// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { Group, Session, InMemoryStorageAdapter, serializeSessionState, deserializeSessionState,
  PRIVATE_GROUP_DELIVERY_KIND, privateGroupDeliveryRumor, type Rumor, type SessionState } from 'nostr-double-ratchet'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools'
import { GROUP_WAKE_KIND, parseGroupWake } from './groupWake'

const key = (n: number) => new Uint8Array(32).fill(n)

it('sends group data only through distinct private sessions and resumes unfinished delivery after restart', async () => {
  const owner = getPublicKey(key(1)), other = getPublicKey(key(2)), sibling = getPublicKey(key(3))
  const device=getPublicKey(key(4))
  const data = {id:'private-group',name:'Friends',members:[owner,other,sibling],admins:[owner],createdAt:100}
  const storage=new InMemoryStorageAdapter()
  const group = new Group({data,ourOwnerPubkey:owner,ourDevicePubkey:device,storage})
  const wires: Event[] = [], wrapped:Array<{recipient:string,event:Event}>=[]
  const sessions = new Map([owner,other,sibling].map((recipient,i) => {
    const a = key(10+i), b = key(20+i), shared = key(30+i)
    return [recipient, {
      send:Session.init(getPublicKey(b),a,true,shared),
      receive:Session.init(getPublicKey(a),b,false,shared).state,
      device:getPublicKey(b),
    }]
  }))
  let online=false
  const deliver=async (recipient:string,rumor:Rumor) => {
    if (rumor.kind===PRIVATE_GROUP_DELIVERY_KIND && recipient===other && !online) throw new Error('offline')
    const pair=sessions.get(recipient)!
    const wire=pair.send.sendEvent(rumor,[['p',pair.device]]).event
    wires.push(wire)
    // Every delivery uses persisted receiving state, including the first reply.
    const restored=new Session(deserializeSessionState(serializeSessionState(pair.receive)))
    const received=restored.receiveEvent(wire)!
    pair.receive=restored.state as SessionState
    if (received.kind===PRIVATE_GROUP_DELIVERY_KIND) wrapped.push({recipient,event:parseGroupWake(received)!})
  }
  const publishOuter=vi.fn(async()=>{throw new Error('A shared group envelope must never be published')})
  const sent=await group.sendMessage('hello',{sendPairwise:deliver,publishOuter})
  expect(publishOuter).not.toHaveBeenCalled()
  expect(wrapped.map(value=>value.recipient).sort()).toEqual([owner,sibling].sort())
  const restarted=new Group({data,ourOwnerPubkey:owner,ourDevicePubkey:device,storage})
  online=true
  await restarted.flushPrivateDeliveries(deliver)
  expect(wrapped.map(value=>value.recipient).sort()).toEqual([owner,other,sibling].sort())
  expect(wrapped.every(value=>value.event.id===sent.outer.id)).toBe(true)
  expect(new Set(wires.map(event=>event.pubkey)).size).toBe(3)
  for (const wire of wires) {
    const serialized = JSON.stringify(wire)
    for (const hidden of [owner,other,sibling,device,sent.outer.pubkey,data.id,sent.outer.id]) {
      expect(serialized).not.toContain(hidden)
    }
    expect(wire.kind).toBe(1060)
    expect(wire.tags.map(tag=>tag[0])).toEqual(['v','header','p'])
  }
})

it('rejects unsigned, obsolete and substituted group envelopes', () => {
  const valid = finalizeEvent({kind:1060,created_at:100,content:'ciphertext',tags:[['v','2']]},key(2))
  const rumor=privateGroupDeliveryRumor(valid,'group',getPublicKey(key(3)))
  expect(rumor.kind).toBe(GROUP_WAKE_KIND)
  expect(JSON.stringify(parseGroupWake(rumor))).toBe(JSON.stringify(valid))
  for(const event of [
    {...valid,content:'substituted'},
    finalizeEvent({kind:1060,created_at:100,content:'legacy',tags:[]},key(2)),
    finalizeEvent({kind:1,created_at:100,content:'public',tags:[['v','2']]},key(2)),
    finalizeEvent({kind:1060,created_at:100,content:'recipient-bearing',tags:[['v','2'],['p',getPublicKey(key(4))]]},key(2)),
  ]) {
    expect(parseGroupWake({kind:GROUP_WAKE_KIND,content:JSON.stringify({v:1,type:'group-wake',event})})).toBeUndefined()
  }
})
