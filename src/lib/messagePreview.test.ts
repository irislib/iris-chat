import { expect, it } from 'vitest'
import { nhashEncode } from '@hashtree/core'
import { messagePreview } from './messagePreview'
import { renderRumor } from './pushRumorRender'
const hash = nhashEncode({hash:new Uint8Array(32).fill(1),key:new Uint8Array(32).fill(2)})
it('valid bare, filename and wrapped attachments are concise without losing captions or touching invalid prose',()=>{
  for(const ref of [hash,`${hash}/photo.jpg`,`htree://${hash}/photo.jpg`,`nhash://${hash}`,`[pic](${hash}/photo.jpg)`,`![pic](htree://${hash}/photo.jpg)`]) {
    expect(messagePreview(ref)).toBe('Attachment')
    expect(messagePreview(`Here it is\n${ref}\nSee you`)).toBe('Here it is\nAttachment\nSee you')
    expect(renderRumor(14,ref)?.body).toBe('Attachment')
  }
  expect(messagePreview(`Photo ${hash}/file.jpg!`)).toBe('Photo Attachment!')
  expect(messagePreview(`${hash}\n${hash}/file.txt`)).toBe('Attachment\nAttachment')
  for (const text of ['nhash1lookslikehash',hash.slice(0,-1)+'x',`prefix${hash}`,'ordinary text']) expect(messagePreview(text)).toBe(text)
})
