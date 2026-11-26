import { Marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'
import { messageMentions } from './mentions'

const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

// Strings free of markdown, HTML, URL/email autolink, and mention triggers render identically to `<p>${text}</p>\n`.
const PLAIN_TEXT_UNSAFE = /^\s|\s$|[\r\n\t<>&*_~`\[\]()\\=|:\/@]| {2,}|^[-+#]|^\d+\.|www\./i
const MAX_CACHE_ENTRIES = 1000
const markdownCache = new Map<string, string>()

let activeNames: Record<string, string> = {}
const renderer = new Renderer()
renderer.link = function (token) {
  const mention = messageMentions(token.raw)[0]
  if (mention?.start === 0 && mention.end === token.raw.length) {
    const label = activeNames[mention.pubkey] ? '@' + activeNames[mention.pubkey] : mention.label
    return `<a href="#profile-${mention.pubkey}" class="message-mention">${escape(label)}</a>`
  }
  return `<a href="${escape(token.href)}" target="_blank" rel="noopener noreferrer">${this.parser.parseInline(token.tokens)}</a>`
}
const marked = new Marked({ gfm: true, breaks: true, renderer })

export function messageMarkdown(text: string, names: Record<string, string> = {}): string {
  if (!text) return ''
  if (!PLAIN_TEXT_UNSAFE.test(text)) return `<p>${text}</p>\n`

  let cacheKey = text
  if (text.includes('](nostr:npub1')) {
    const mentions = messageMentions(text)
    if (mentions.length > 0) {
      cacheKey = `${text}\0${mentions.map((mention) => `${mention.pubkey}=${names[mention.pubkey] ?? ''}`).join('\0')}`
    }
  }

  const cached = markdownCache.get(cacheKey)
  if (cached !== undefined) {
    markdownCache.delete(cacheKey)
    markdownCache.set(cacheKey, cached)
    return cached
  }

  activeNames = names
  let html: string
  try {
    html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { ADD_ATTR: ['target'] })
  } finally {
    activeNames = {}
  }

  if (markdownCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = markdownCache.keys().next().value
    if (oldest !== undefined) markdownCache.delete(oldest)
  }
  markdownCache.set(cacheKey, html)
  return html
}
