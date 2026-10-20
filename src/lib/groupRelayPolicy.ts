import type { Filter } from 'nostr-tools'
import type { NostrFetch, NostrSubscribe } from 'nostr-double-ratchet'
import { db } from './storage'

async function sharedGroupAuthors(): Promise<Set<string>> {
  const rows=await db.sessionManager.where('key').startsWith('v1/broadcast-channel/group/').toArray()
  return new Set(rows.filter(row=>row.key.endsWith('/sender-event-pubkey') && typeof row.value==='string')
    .map(row=>row.value as string))
}

/** A shared channel is decoded locally, never subscribed to on a message server. */
export async function privateGroupRelayFilter(filter:Filter):Promise<Filter | undefined> {
  if ((!filter.kinds || filter.kinds.includes(37368)) && filter['#type']?.includes('group_roster')) return
  if (filter.kinds && !filter.kinds.includes(1060) || !filter.authors?.length) return filter
  const shared=await sharedGroupAuthors()
  const authors=filter.authors.filter(author=>!shared.has(author))
  if (!authors.length) return
  return {...filter,authors}
}

export function privateGroupRelaySubscribe(subscribe:NostrSubscribe):NostrSubscribe {
  return (filter,onEvent)=>{
    let closed=false,stop:(()=>void) | undefined
    void privateGroupRelayFilter(filter).then(safe=>{
      if (!closed && safe) stop=subscribe(safe,onEvent)
    }).catch(error=>console.warn('Private message subscription could not start',error))
    return ()=>{closed=true;stop?.()}
  }
}

export function privateGroupRelayFetch(fetch:NostrFetch):NostrFetch {
  return async filter=>{
    const safe=await privateGroupRelayFilter(filter)
    return safe ? fetch(safe) : []
  }
}
