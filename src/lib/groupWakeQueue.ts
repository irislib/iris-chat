import type { GroupData, NdrRuntime, Rumor, StorageAdapter } from 'nostr-double-ratchet'
import { getEventHash, type VerifiedEvent } from 'nostr-tools'
import { GROUP_WAKE_KIND, groupWakeRumor } from './groupWake'
import type { RuntimePublishContext } from './runtimePublish'

type Job = {groupId:string;event:VerifiedEvent;remaining:string[]}
type Options = {
  owner:string
  storage:StorageAdapter
  runtime():Pick<NdrRuntime,'sendEvent'>
  group(id:string):Promise<(GroupData & {accepted?:boolean}) | undefined>
  localSender(id:string):Promise<string | undefined>
  canSend?(member:string,createdAt:number):Promise<boolean | 'hold'>
  active():boolean
  onError(error:unknown):void
}

/** Persist private-delivery intent before the shared outer can leave the device. */
export function createGroupWakeQueue(options:Options): {
  enqueue(event:VerifiedEvent,context?:RuntimePublishContext):Promise<void>
  retry():Promise<void>
  publicationContext(innerEventId:string | undefined,context:RuntimePublishContext | undefined):Promise<RuntimePublishContext | undefined>
  start():void
  close():void
} {
  const prefix=`iris-group-wakes:v1:${options.owner}/`
  const completePrefix=`iris-group-wakes-complete:v1:${options.owner}/`
  let closed=false, running:Promise<void> | undefined
  let timer:ReturnType<typeof setInterval> | undefined
  const active=()=>!closed && options.active()
  const retry=():Promise<void> => {
    if (running) return running
    running=(async()=>{
      for (const key of await options.storage.list(prefix)) {
        if (!active()) return
        const job=await options.storage.get<Job>(key)
        if (!job) continue
        for (const member of [...job.remaining]) {
          if (!active()) return
          const group=await options.group(job.groupId)
          if (!active()) return
          // A missing projection can still be restoring after a restart.
          if (!group) continue
          const allowed=group.accepted !== false && group.members.includes(options.owner) && group.members.includes(member)
            ? await options.canSend?.(member,job.event.created_at) ?? true : false
          if (!active()) return
          if (allowed === 'hold') continue
          if (allowed) {
            // The library's durable queue is keyed by rumor ID. Build the full
            // event now so different offline wakes cannot overwrite each other.
            // Recipient and group policy tags remain inside the ratchet.
            const rumor:Rumor={...groupWakeRumor(job.event),pubkey:options.owner,
              created_at:job.event.created_at,tags:[['l',job.groupId],['p',member]],id:''}
            rumor.id=getEventHash(rumor)
            try { await options.runtime().sendEvent(member,rumor,options.owner,{includeLocalSiblings:false}) }
            catch(error) { options.onError(error); continue }
          }
          if (!active()) return
          job.remaining=job.remaining.filter(value=>value!==member)
          // If a crash follows the ratchet handoff but precedes this checkpoint,
          // retrying carries the same signed group event and canonical message ID.
          await options.storage.put(key,job)
        }
        if (active() && !job.remaining.length) {
          await options.storage.put(completePrefix+job.event.id,job.event.created_at)
          await options.storage.del(key)
          const completed=await options.storage.list(completePrefix)
          if (completed.length>4096) {
            const oldest=await Promise.all(completed.map(async key=>({key,at:await options.storage.get<number>(key) ?? 0})))
            oldest.sort((a,b)=>a.at-b.at || a.key.localeCompare(b.key))
            for (const row of oldest.slice(0,completed.length-4096)) await options.storage.del(row.key)
          }
        }
      }
    })().finally(()=>{running=undefined})
    return running
  }
  return {
    async enqueue(event:VerifiedEvent,context?:RuntimePublishContext) {
      const groupId=context?.groupId
      if (!groupId || event.kind!==1060) return
      if (!active()) throw new Error('Group delivery is not ready')
      if (await options.localSender(groupId)!==event.pubkey) return
      const group=await options.group(groupId)
      if (!active()) throw new Error('Account changed')
      if (!group || group.accepted===false || !group.members.includes(options.owner)) return
      groupWakeRumor(event)
      const key=prefix+event.id
      if (await options.storage.get(completePrefix+event.id)) return
      if (!await options.storage.get(key)) {
        await options.storage.put(key,{groupId,event:structuredClone(event),remaining:[...new Set(group.members)]} satisfies Job)
      }
      if (!active()) throw new Error('Account changed')
    },
    retry,
    async publicationContext(innerEventId:string | undefined,context:RuntimePublishContext | undefined):Promise<RuntimePublishContext | undefined> {
      if (!innerEventId || !context?.groupId || context.recipientOwnerPubkey) return context
      // sendEvent persists its plaintext queue before invoking the publication
      // hooks. Carry both policies into the host outbox before that queue is ACKed.
      for (const prefix of ['v1/message-queue/','v1/discovery-queue/']) {
        const keys:string[]=await options.storage.list(`${prefix}${innerEventId}/`)
        for (const key of keys) {
          const entry:{event:Rumor} | undefined=await options.storage.get(key)
          const rumor:Rumor | undefined=entry?.event
          if (rumor?.kind!==GROUP_WAKE_KIND || rumor.id!==innerEventId ||
            rumor.tags.find(tag=>tag[0]==='l')?.[1]!==context.groupId) continue
          const recipientOwnerPubkey=rumor.tags.find(tag=>tag[0]==='p')?.[1]
          if (recipientOwnerPubkey) return {...context,recipientOwnerPubkey,createdAt:rumor.created_at}
        }
      }
      return context
    },
    start() {
      if (timer || closed) return
      const run=()=>{void retry().catch(options.onError)}
      timer=setInterval(run,2500)
      run()
    },
    close() {closed=true;clearInterval(timer)},
  }
}
