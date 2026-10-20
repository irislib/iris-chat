import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Filter } from 'nostr-tools'
import { db } from './storage'
import { privateGroupRelayFetch, privateGroupRelaySubscribe } from './groupRelayPolicy'

const shared='a'.repeat(64), session='b'.repeat(64)
beforeEach(async()=>{
  await db.sessionManager.clear()
  await db.sessionManager.put({key:'v1/broadcast-channel/group/friends/sender/device/sender-event-pubkey',value:shared})
})

it('keeps shared group authors out of serialized live and backfill relay requests',async()=>{
  const requests:string[]=[]
  const subscribe=vi.fn((filter:Filter)=>{requests.push(JSON.stringify(filter));return()=>{}})
  const fetch=vi.fn(async (filter:Filter)=>{requests.push(JSON.stringify(filter));return[]})
  const live=privateGroupRelaySubscribe(subscribe), backfill=privateGroupRelayFetch(fetch)
  const stop=live({kinds:[1060],authors:[shared,session]},()=>{})
  await backfill({kinds:[1060],authors:[shared,session],since:1})
  await vi.waitFor(()=>expect(subscribe).toHaveBeenCalledTimes(1))
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(requests.every(wire=>!wire.includes(shared) && wire.includes(session))).toBe(true)
  stop()
  live({kinds:[1060],authors:[shared]},()=>{})
  await backfill({kinds:[1060],authors:[shared],since:1})
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(subscribe).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('never opens public membership discovery and respects cancellation before storage is ready',async()=>{
  const subscribe=vi.fn(()=>()=>{}), fetch=vi.fn(async()=>[])
  const live=privateGroupRelaySubscribe(subscribe), backfill=privateGroupRelayFetch(fetch)
  live({kinds:[37368],'#type':['group_roster']},()=>{})
  await backfill({kinds:[37368],'#type':['group_roster'],limit:200})
  const stop=live({kinds:[1060],authors:[session]},()=>{})
  stop()
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(subscribe).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})
