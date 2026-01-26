<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import type { ChatMessage } from '../lib/chat'

  interface Props {
    message: ChatMessage
    isFirst: boolean
    isLast: boolean
    prevHasReactions?: boolean
    hasReactions?: boolean
    showSenderName?: boolean
    senderName?: string
    onreact?: (messageId: string, emoji: string) => Promise<void>
  }

  let { message, isFirst, isLast, prevHasReactions = false, hasReactions = false, showSenderName = false, senderName, onreact }: Props = $props()

  // For styling: treat as visually first/last if adjacent to reactions
  let styleFirst = $derived(isFirst || prevHasReactions)
  let styleLast = $derived(isLast || hasReactions)

  let showEmojiPicker = $state(false)
  let isHovered = $state(false)

  const quickEmojis = ['❤️', '👍', '😂', '😮', '😢', '🙏']

  async function handleReact(emoji: string) {
    showEmojiPicker = false
    isHovered = false
    await onreact?.(message.id, emoji)
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && showEmojiPicker) {
      showEmojiPicker = false
      isHovered = false
    }
  }

  function closePicker() {
    showEmojiPicker = false
    isHovered = false
  }

  // Listen for escape key
  $effect(() => {
    if (showEmojiPicker) {
      document.addEventListener('keydown', handleKeydown)
      return () => document.removeEventListener('keydown', handleKeydown)
    }
  })

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

<div class="{styleFirst ? 'mt-3' : 'mt-0.5'}">
  {#if isFirst}
    <div class="flex items-center gap-2 mb-1 {message.isMine ? 'justify-end' : ''}">
      {#if showSenderName && senderName}
        <span class="text-xs text-gray-400 font-medium">{senderName}</span>
      {/if}
      <span class="text-xs text-gray-600">{formatTime(message.timestamp)}</span>
    </div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="flex items-center gap-1 {message.isMine ? 'justify-end' : ''}"
    onmouseenter={() => isHovered = true}
    onmouseleave={() => { if (!showEmojiPicker) isHovered = false }}
  >
    <!-- Reaction button - before message for own messages -->
    {#if message.isMine && (isHovered || showEmojiPicker) && onreact}
      <div class="relative">
        <button
          class="w-7 h-7 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
          onclick={() => showEmojiPicker = !showEmojiPicker}
          aria-label="Add reaction"
        >
          <span class="i-carbon-face-add text-sm"></span>
        </button>
        {#if showEmojiPicker}
          <div class="absolute right-0 bottom-full mb-1 z-30 bg-surface border border-surface-lighter rounded-full px-2 py-1 flex gap-1 shadow-xl">
            {#each quickEmojis as emoji}
              <button
                class="w-8 h-8 rounded-full hover:bg-surface-light flex items-center justify-center text-lg transition-colors"
                onclick={() => handleReact(emoji)}
              >
                {emoji}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <div class="max-w-[85%] relative {message.reactions && Object.keys(message.reactions).length > 0 ? 'mb-4' : ''}">
      <div class="px-3 py-1.5 text-sm break-all overflow-hidden {getBubbleClass(message.isMine, styleFirst, styleLast)}">{#each parseMessageWithLinks(message.content) as part}{#if part.type === 'link'}<a href={part.content} target="_blank" rel="noopener noreferrer" class="underline hover:opacity-80 break-all {message.isMine ? 'text-white' : 'text-primary'}">{part.content}</a>{:else}{part.content}{/if}{/each}</div>

      <!-- Reactions display - positioned to overlap bottom of message -->
      {#if message.reactions && Object.keys(message.reactions).length > 0}
        <div class="absolute -bottom-4 right-2 flex gap-1">
          {#each Object.entries(message.reactions) as [emoji, users]}
            <span class="reaction px-1.5 py-0.5 bg-surface border border-surface-lighter rounded-full text-xs flex items-center gap-1 shadow-sm">
              {emoji}
              {#if users.length > 1}
                <span class="text-gray-400">{users.length}</span>
              {/if}
            </span>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Reaction button - after message for their messages -->
    {#if !message.isMine && (isHovered || showEmojiPicker) && onreact}
      <div class="relative">
        <button
          class="w-7 h-7 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
          onclick={() => showEmojiPicker = !showEmojiPicker}
          aria-label="Add reaction"
        >
          <span class="i-carbon-face-add text-sm"></span>
        </button>
        {#if showEmojiPicker}
          <div class="absolute left-0 bottom-full mb-1 z-30 bg-surface border border-surface-lighter rounded-full px-2 py-1 flex gap-1 shadow-xl">
            {#each quickEmojis as emoji}
              <button
                class="w-8 h-8 rounded-full hover:bg-surface-light flex items-center justify-center text-lg transition-colors"
                onclick={() => handleReact(emoji)}
              >
                {emoji}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<!-- Click outside to close emoji picker -->
{#if showEmojiPicker}
  <button
    class="fixed inset-0 z-20 bg-transparent border-none cursor-default"
    onclick={closePicker}
    aria-label="Close picker"
  ></button>
{/if}
