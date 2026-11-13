// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { Group, InMemoryStorageAdapter,
  privateGroupDeliveryRumor, type Rumor } from 'nostr-double-ratchet'
import { finalizeEvent, getPublicKey, type VerifiedEvent } from 'nostr-tools'
import { GROUP_WAKE_KIND, parseGroupWake } from './groupWake'

const key = (n: number) => new Uint8Array(32).fill(n)

it('publishes one signed ciphertext after recipient sessions have received the sender key', async () => {
  const owner = getPublicKey(key(1)), other = getPublicKey(key(2)), sibling = getPublicKey(key(3))
  const device = getPublicKey(key(4))
  const data = {id:'private-group',name:'Friends',members:[owner,other,sibling],admins:[owner],createdAt:100}
  const storage = new InMemoryStorageAdapter()
  const group = new Group({data,ourOwnerPubkey:owner,ourDevicePubkey:device,storage})
  const controls: Rumor[] = []
  const sendPairwise = async (_recipient: string, rumor: Rumor) => { controls.push(rumor) }
  const publishOuter = vi.fn(async (event: VerifiedEvent) => event)
  await group.sendMessage('first', {sendPairwise, publishOuter})
  expect(controls.length).toBeGreaterThan(0)
  controls.length = 0
  publishOuter.mockClear()
  const restored = new Group({data,ourOwnerPubkey:owner,ourDevicePubkey:device,storage})
  const sent = await restored.sendMessage('next', {sendPairwise, publishOuter})
  expect(publishOuter).toHaveBeenCalledTimes(1)
  expect(publishOuter).toHaveBeenCalledWith(sent.outer, sent.inner.id,
    {groupId:data.id,groupSenderKey:true,groupMemberPubkeys:[owner,other,sibling].sort()})
  expect(controls).toEqual([])
  for (const hidden of [owner,other,sibling,device,data.id,sent.inner.id]) {
    expect(JSON.stringify(sent.outer)).not.toContain(hidden)
  }
  expect(sent.outer.tags.map(tag=>tag[0])).toEqual(['v','header'])
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
