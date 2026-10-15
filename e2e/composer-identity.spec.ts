import { test, expect } from './fixtures'
import { getPublicKey, nip19 } from 'nostr-tools'
import type { Locator, Page } from '@playwright/test'
const owner=getPublicKey(new Uint8Array(32).fill(21)), peer='c'.repeat(64)

async function openEqualNames(page: Page) {
  await page.addInitScript(({owner,peer})=>{
    localStorage.setItem('iris-chat-identity','15'.repeat(32))
    for (const person of [owner,peer]) localStorage.setItem(`iris-contact-memory:v1:${owner}:${person}`,JSON.stringify({first_seen_name:'Alex',accepted_name:'Alex'}))
  },{owner,peer})
  await page.goto('/')
  await page.getByRole('button',{name:'New Chat',exact:true}).click()
  await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode(peer))
  const input=page.getByPlaceholder('Type a message...')
  await expect(input).toBeVisible()
  return input
}
async function insert(page:Page,input:Locator,index:number) {
  await input.pressSequentially('@')
  const options=page.getByRole('listbox',{name:'Mention someone'}).getByRole('option')
  await expect(options).toHaveCount(2)
  for(const option of await options.all()) await expect(option).toHaveAccessibleName(/@Alex, npub1/)
  expect(await options.nth(0).innerText()).not.toBe(await options.nth(1).innerText())
  await page.screenshot({path:'work/web-mentions-same-name.png'})
  await options.nth(index).click()
}
async function insertBoth(page:Page,input:Locator) {
  await insert(page,input,0);await insert(page,input,1)
  await expect(input).toHaveValue('@Alex @Alex ')
}
async function sentIdentities(page:Page,expected:string[]) {
  const links=page.locator('.message-content').last().locator('a.message-mention')
  await expect(links).toHaveCount(expected.length)
  for(let i=0;i<expected.length;i++) await expect(links.nth(i)).toHaveAttribute('href',`#profile-${expected[i]}`)
}
for(const removed of [0,1]) test(`deleting equal-name mention ${removed+1} preserves the other person's identity`,async({page})=>{
  const input=await openEqualNames(page)
  await insertBoth(page,input)
  await input.evaluate((element,start)=>element.setSelectionRange(start,start+6),removed*6)
  await input.press('Backspace')
  await expect(input).toHaveValue('@Alex ')
  await input.press('Enter')
  await sentIdentities(page,[removed===0?owner:peer])
})
test('completion insertion undo and redo restore its original identity',async({page})=>{
  const input=await openEqualNames(page)
  await insert(page,input,1)
  await input.press('ControlOrMeta+z')
  await expect(input).toHaveValue('@')
  await expect(page.locator('.message-content')).toHaveCount(0)
  await input.press('ControlOrMeta+Shift+z')
  await expect(input).toHaveValue('@Alex ')
  await input.press('Enter')
  await sentIdentities(page,[owner])
})
test('undoing an edit inside one equal-name token restores its exact identity',async({page})=>{
  const input=await openEqualNames(page)
  await insertBoth(page,input)
  await input.evaluate(element=>element.setSelectionRange(10,11))
  await input.pressSequentially('c')
  await expect(input).toHaveValue('@Alex @Alec ')
  await input.press('ControlOrMeta+z')
  await expect(input).toHaveValue('@Alex @Alex ')
  await input.press('ControlOrMeta+Shift+z')
  await expect(input).toHaveValue('@Alex @Alec ')
  await input.press('ControlOrMeta+z')
  await input.press('Enter')
  await sentIdentities(page,[peer,owner])
})
test('an edit inside a mention leaves only that token plain, and immediate Enter selects before sending',async({page})=>{
  const input=await openEqualNames(page)
  await insertBoth(page,input)
  await input.evaluate(element=>element.setSelectionRange(10,11))
  await input.pressSequentially('c');await input.press('Enter')
  await sentIdentities(page,[peer])
  await input.pressSequentially('@');await input.press('Enter')
  await expect(input).toHaveValue('@Alex ')
  await expect(page.locator('.message-content')).toHaveCount(1)
  await input.press('Enter')
  await sentIdentities(page,[peer])
})

test('browser undo commands preserve identity metadata as well as keyboard shortcuts',async({page})=>{
  const input=await openEqualNames(page)
  await insert(page,input,1)
  await input.evaluate(()=>document.execCommand('undo'))
  await expect(input).toHaveValue('@')
  await input.evaluate(()=>document.execCommand('redo'))
  await expect(input).toHaveValue('@Alex ')
  await input.press('Enter')
  await sentIdentities(page,[owner])
  await input.evaluate(()=>document.execCommand('undo'))
  await expect(input).toHaveValue('')
})
test('composition and paste transactions restore exact metadata on undo',async({page})=>{
  const input=await openEqualNames(page)
  await insertBoth(page,input)
  // Exercise browser event transactions without touching the user's OS clipboard/IME.
  await input.evaluate(element=>{
    element.setSelectionRange(6,12)
    const data=new DataTransfer();data.setData('text/plain','@Alex ')
    element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))
    element.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertFromPaste',data:'@Alex '}))
    element.setRangeText('@Alex ',6,12,'end')
    element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste',data:'@Alex '}))
  })
  await input.press('ControlOrMeta+z')
  await input.evaluate(element=>{
    element.setSelectionRange(10,11)
    element.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))
    element.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertCompositionText',data:'é',isComposing:true}))
    element.setRangeText('é',10,11,'end')
    element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'é',isComposing:true}))
    element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'é'}))
  })
  await expect(input).toHaveValue('@Alex @Aleé ')
  await input.press('ControlOrMeta+z')
  await expect(input).toHaveValue('@Alex @Alex ')
  await input.press('Enter')
  await sentIdentities(page,[peer,owner])
})
