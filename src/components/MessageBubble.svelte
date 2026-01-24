<script lang="ts">
  import type { ChatMessage } from '../lib/chat'

  interface Props {
    message: ChatMessage
    isFirst: boolean
    isLast: boolean
  }

  let { message, isFirst, isLast }: Props = $props()

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  function getBubbleClass(isOwn: boolean, isFirst: boolean, isLast: boolean): string {
    const base = isOwn ? 'bg-primary text-white' : 'bg-surface-light text-gray-200'

    if (isFirst && isLast) {
      return `${base} rounded-2xl`
    }
    if (isFirst) {
      return isOwn
        ? `${base} rounded-t-2xl rounded-bl-2xl rounded-br-sm`
        : `${base} rounded-t-2xl rounded-br-2xl rounded-bl-sm`
    }
    if (isLast) {
      return isOwn
        ? `${base} rounded-b-2xl rounded-tl-2xl rounded-tr-sm`
        : `${base} rounded-b-2xl rounded-tr-2xl rounded-tl-sm`
    }
    return isOwn
      ? `${base} rounded-l-2xl rounded-r-sm`
      : `${base} rounded-r-2xl rounded-l-sm`
  }

  // Simple URL regex
  const urlRegex = /(https?:\/\/[^\s<]+[^\s<.,;:!?"'\])>])/g

  function parseMessageWithLinks(text: string): Array<{ type: 'text' | 'link', content: string }> {
    const parts: Array<{ type: 'text' | 'link', content: string }> = []
    let lastIndex = 0
    let match

    while ((match = urlRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: text.slice(lastIndex, match.index) })
      }
      parts.push({ type: 'link', content: match[0] })
      lastIndex = urlRegex.lastIndex
    }

    if (lastIndex < text.length) {
      parts.push({ type: 'text', content: text.slice(lastIndex) })
    }

    // Reset regex state
    urlRegex.lastIndex = 0

    return parts.length > 0 ? parts : [{ type: 'text', content: text }]
  }
</script>

<div class="{isFirst ? 'mt-3' : 'mt-0.5'}">
  {#if isFirst}
    <div class="flex items-center gap-2 mb-1 {message.isMine ? 'justify-end' : ''}">
      <span class="text-xs text-gray-400 font-medium">{message.isMine ? 'You' : 'Them'}</span>
      <span class="text-xs text-gray-600">{formatTime(message.timestamp)}</span>
    </div>
  {/if}
  <div class="flex {message.isMine ? 'justify-end' : ''}">
    <div class="max-w-[85%] px-3 py-1.5 text-sm break-words overflow-hidden {getBubbleClass(message.isMine, isFirst, isLast)}">{#each parseMessageWithLinks(message.content) as part}{#if part.type === 'link'}<a href={part.content} target="_blank" rel="noopener noreferrer" class="underline hover:opacity-80 break-all {message.isMine ? 'text-white' : 'text-primary'}">{part.content}</a>{:else}{part.content}{/if}{/each}</div>
  </div>
</div>
