import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import { db } from './storage'
import { applyMessageRead } from './privateStateStore'
import { showUnreadNotification } from './readNotifications'
const owner = 'a'.repeat(64), chatId = 'b'.repeat(64)
const message = {ownerPubkey:owner,chatId,messageId:'read',createdAtSecs:100}
let notifications: Array<{data: typeof message;close:ReturnType<typeof vi.fn>}> = []
const registration = {getNotifications:vi.fn(async()=>notifications as unknown as Notification[]),showNotification:vi.fn(async()=>{})}
beforeEach(async()=>{
  await db.sessionManager.clear();await db.messages.clear();notifications=[];vi.clearAllMocks()
  await db.sessionManager.put({key:'v1/device-manager/owner-pubkey',value:owner})
  vi.stubGlobal('navigator',{serviceWorker:{getRegistration:async()=>registration}})
})
it('received exact reads dismiss only their account/message alert, including before the original exists',async()=>{
  notifications = [message,{...message,messageId:'unread'},{...message,ownerPubkey:'c'.repeat(64)},{...message,createdAtSecs:101}].map(data=>({data,close:vi.fn()}))
  await applyMessageRead(owner,chatId,'read',{createdAtSecs:100},()=>true)
  expect(notifications.map(n=>n.close.mock.calls.length)).toEqual([1,0,0,0])
  expect(await db.messages.count()).toBe(0)
})
it('read during asynchronous notification enqueue closes only the just-read message, preserving a newer alert',async()=>{
  let finish!:()=>void
  registration.showNotification.mockImplementationOnce(async()=>{
    await new Promise<void>(resolve=>{finish=resolve})
    notifications.push({data:message,close:vi.fn()},{data:{...message,messageId:'new'},close:vi.fn()})
  })
  const posting = showUnreadNotification(registration,message,'Alice',{body:'Hi'})
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
  await applyMessageRead(owner,chatId,'read',{createdAtSecs:100},()=>true)
  finish();await posting
  expect(notifications.map(n=>n.close.mock.calls.length)).toEqual([1,0])
  registration.showNotification.mockClear()
  await showUnreadNotification(registration,message,'Alice',{body:'Hi'})
  expect(registration.showNotification).not.toHaveBeenCalled()
})

it('serializes relay and worker notification enqueue for the same message without replacing its alert',async()=>{
  let queue=Promise.resolve()
  vi.stubGlobal('navigator',{serviceWorker:{getRegistration:async()=>registration},locks:{request:(_name:string,work:()=>Promise<void>)=>{const next=queue.then(work);queue=next;return next}}})
  registration.showNotification.mockImplementation(async()=>{notifications.push({data:message,close:vi.fn()})})
  await Promise.all([showUnreadNotification(registration,message,'Alice',{body:'Hi'}),showUnreadNotification(registration,message,'Alice',{body:'Hi'})])
  expect(registration.showNotification).toHaveBeenCalledOnce()
  expect(notifications).toHaveLength(1)
})
