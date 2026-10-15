import { nhashDecode } from '@hashtree/core'
import { displayMentions } from './mentions'
import { directFilePreview } from './directFileProtocol'
const reference = /(?<![\p{L}\p{N}_])(?:(?:htree|nhash):\/\/)?nhash1[a-z0-9]+(?:\/[^\s<>\]\)]+)?/giu
function attachmentReference(text: string): boolean {
  const hash = text.replace(/^(?:htree|nhash):\/\//i,'').split('/')[0]
  try { const cid = nhashDecode(hash); return cid.hash.length === 32 && (!cid.key || cid.key.length === 32) } catch { return false }
}
/** Presentation only: never resolve a tree or rewrite the saved message. */
export function messagePreview(content: string, names: Record<string,string> = {}): string {
  let text = displayMentions(directFilePreview(content),names)
  // Replace whole Markdown wrappers so the filename cannot expose the same hash.
  text = text.replace(/!?\[[^\]\n]*\]\(([^\s)]+)\)/g,(whole,target:string)=>attachmentReference(target) ? 'Attachment' : whole)
  return text.replace(reference,match=>{
    const punctuation = /[.,!?;:]+$/.exec(match)?.[0] ?? ''
    const candidate = punctuation ? match.slice(0,-punctuation.length) : match
    return attachmentReference(candidate) ? 'Attachment' + punctuation : match
  })
}
