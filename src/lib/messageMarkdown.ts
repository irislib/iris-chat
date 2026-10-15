import { Marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'
import { messageMentions } from './mentions'
const escape = (text: string) => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')
export function messageMarkdown(text: string, names: Record<string,string> = {}): string {
  const renderer = new Renderer()
  renderer.link = function(token) {
    const mention = messageMentions(token.raw)[0]
    if (mention?.start === 0 && mention.end === token.raw.length) {
      const label = names[mention.pubkey] ? '@' + names[mention.pubkey] : mention.label
      return `<a href="#profile-${mention.pubkey}" class="message-mention">${escape(label)}</a>`
    }
    return `<a href="${escape(token.href)}" target="_blank" rel="noopener noreferrer">${this.parser.parseInline(token.tokens)}</a>`
  }
  return DOMPurify.sanitize(new Marked({ gfm:true, breaks:true, renderer }).parse(text, { async:false }) as string, { ADD_ATTR:['target'] })
}
