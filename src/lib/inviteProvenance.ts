import { hasMetadataPrivacyVersion } from 'nostr-double-ratchet'
import { verifyEvent, type Event } from 'nostr-tools'
import { db } from './storage'

const prefix='iris-invite-response:v2:'
type Evidence = { recipient:string; recordedAt:number }

/** Record routing evidence before the library authenticates and installs a session. */
export async function rememberInviteResponse(event:Event):Promise<void> {
  if (event.kind!==1059 || !hasMetadataPrivacyVersion(event)) return
  const recipients=event.tags.filter(tag=>tag[0]==='p')
  if (recipients.length!==1 || !/^[a-f0-9]{64}$/.test(recipients[0][1]??'')) return
  const wire=JSON.parse(JSON.stringify(event)) as Event
  if (!verifyEvent(wire)) return
  await db.transaction('rw',db.sessionManager,async()=>{
    const key=prefix+wire.id
    if (await db.sessionManager.get(key)) return
    await db.sessionManager.put({key,value:{recipient:recipients[0][1],recordedAt:Date.now()} satisfies Evidence})
    const records=await db.sessionManager.where('key').startsWith(prefix).toArray()
    if (records.length>4096) {
      records.sort((a,b)=>((a.value as Evidence)?.recordedAt ?? 0)-((b.value as Evidence)?.recordedAt ?? 0) || a.key.localeCompare(b.key))
      await db.sessionManager.bulkDelete(records.slice(0,records.length-4096).map(record=>record.key))
    }
  })
}

/** SessionManager assigns this name only after authenticating the invite response.
 * A recipient tag alone never authorizes a chat, and a ratchet signer is not an invite key. */
export async function sessionFromLocalInvite(session:unknown,issuedInviteKeys:Set<string>):Promise<boolean> {
  const responseId=(session as {name?:unknown}|undefined)?.name
  if (typeof responseId!=='string' || !/^[a-f0-9]{64}$/.test(responseId)) return false
  const evidence=(await db.sessionManager.get(prefix+responseId))?.value
  const recipient=typeof evidence==='string' ? evidence : (evidence as Evidence | undefined)?.recipient
  return typeof recipient==='string' && issuedInviteKeys.has(recipient)
}
