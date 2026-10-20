import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { Invite, type Session, type NostrSubscribe } from 'nostr-double-ratchet'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'
import { db } from './storage'
import { rememberInviteResponse, sessionFromLocalInvite } from './inviteProvenance'

beforeEach(async()=>{await db.sessionManager.clear()})

it('recognizes only an authenticated response to a locally issued invite after restart',async()=>{
  const identity=generateSecretKey(), peer=generateSecretKey()
  const invite=Invite.createNew(getPublicKey(identity),getPublicKey(identity))
  const accepted=await invite.accept(getPublicKey(peer),peer)
  let handler:Parameters<NostrSubscribe>[1]|undefined
  let session:Session|undefined
  invite.listen(identity,(_filter,callback)=>{handler=callback;return()=>{}},value=>{session=value})
  await rememberInviteResponse(accepted.event)
  await handler!(accepted.event)
  expect(session?.name).toBe(accepted.event.id)
  const owned=new Set([invite.inviterEphemeralPublicKey])
  expect(await sessionFromLocalInvite({name:session!.name},owned)).toBe(true)
  expect(await sessionFromLocalInvite({name:session!.name},new Set(['0'.repeat(64)]))).toBe(false)
  expect(await sessionFromLocalInvite({state:{ourCurrentNostrKey:{publicKey:invite.inviterEphemeralPublicKey}}},owned)).toBe(false)

  const bogus=finalizeEvent({kind:1059,created_at:1,content:'not an invite response',tags:[['v','2'],['p',invite.inviterEphemeralPublicKey]]},peer)
  await rememberInviteResponse(bogus)
  session=undefined
  await handler!(bogus)
  expect(session).toBeUndefined()
  // The untrusted recipient tag has no matching authenticated session.
  expect(await sessionFromLocalInvite(undefined,owned)).toBe(false)
})

it('does not record unsigned or altered routing evidence',async()=>{
  const event=finalizeEvent({kind:1059,created_at:1,content:'sealed',tags:[['v','2'],['p','a'.repeat(64)]]},generateSecretKey())
  await rememberInviteResponse({...event,content:'altered'})
  expect(await sessionFromLocalInvite({name:event.id},new Set(['a'.repeat(64)]))).toBe(false)
})

it('bounds routing evidence while retaining the newest authenticated response across reloads',async()=>{
  const prefix='iris-invite-response:v2:'
  await db.sessionManager.bulkPut(Array.from({length:4096},(_,index)=>({
    key:prefix+index.toString(16).padStart(64,'0'),value:{recipient:'a'.repeat(64),recordedAt:index},
  })))
  const event=finalizeEvent({kind:1059,created_at:1,content:'sealed',tags:[['v','2'],['p','b'.repeat(64)]]},generateSecretKey())
  await rememberInviteResponse(event)
  expect(await db.sessionManager.where('key').startsWith(prefix).count()).toBe(4096)
  expect(await db.sessionManager.get(prefix+'0'.repeat(64))).toBeUndefined()
  expect(await sessionFromLocalInvite({name:event.id},new Set(['b'.repeat(64)]))).toBe(true)
})
