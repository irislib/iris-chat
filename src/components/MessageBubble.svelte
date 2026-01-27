<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
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
    ondelete?: (messageId: string) => void
  }

  let { message, isFirst, isLast, prevHasReactions = false, hasReactions = false, showSenderName = false, senderName, onreact, ondelete }: Props = $props()

  // For styling: treat as visually first/last if adjacent to reactions
  let styleFirst = $derived(isFirst || prevHasReactions)
  let styleLast = $derived(isLast || hasReactions)

  let showEmojiPicker = $state(false)
  let showMenu = $state(false)
  let isHovered = $state(false)

  const quickEmojis = ['❤️', '👍', '😂', '😮', '😢', '🙏']

  async function handleCopy() {
    await navigator.clipboard.writeText(message.content)
    showMenu = false
    isHovered = false
  }

  function handleDelete() {
    ondelete?.(message.id)
    showMenu = false
    isHovered = false
  }

  function closeMenu() {
    showMenu = false
    isHovered = false
  }

  // Configure marked for GFM (GitHub Flavored Markdown)
  marked.setOptions({
    gfm: true,
    breaks: true, // Convert \n to <br>
  })

  // Render markdown content safely
  let htmlContent = $derived.by(() => {
    const raw = marked.parse(message.content, { async: false }) as string
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target'], // Allow target="_blank" on links
    })
  })

  // Check if content has any markdown formatting
  let hasMarkdown = $derived.by(() => {
    const content = message.content
    // Check for common markdown patterns
    return /[*_`#\[\]!\-]/.test(content) || 
           /```/.test(content) ||
           /\n/.test(content)
  })

  async function handleReact(emoji: string) {
    showEmojiPicker = false
    isHovered = false
    await onreact?.(message.id, emoji)
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (showEmojiPicker) {
        showEmojiPicker = false
        isHovered = false
      }
      if (showMenu) {
        showMenu = false
        isHovered = false
      }
    }
  }

  function closePicker() {
    showEmojiPicker = false
    isHovered = false
  }

  // Listen for escape key
  $effect(() => {
    if (showEmojiPicker || showMenu) {
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
    class="flex items-center gap-1 min-w-0 {message.isMine ? 'justify-end' : ''}"
    onmouseenter={() => isHovered = true}
    onmouseleave={() => { if (!showEmojiPicker && !showMenu) isHovered = false }}
  >
    <!-- Action buttons - before message for own messages -->
    {#if message.isMine && (isHovered || showEmojiPicker || showMenu)}
      <!-- Menu button -->
      <div class="relative">
        <button
          class="w-7 h-7 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
          onclick={() => showMenu = !showMenu}
          aria-label="Message menu"
        >
          <span class="i-carbon-overflow-menu-vertical text-sm"></span>
        </button>
        {#if showMenu}
          <div class="absolute right-0 bottom-full mb-1 z-30 bg-surface border border-surface-lighter rounded-lg py-1 shadow-xl min-w-32">
            <button
              class="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-surface-light flex items-center gap-2 transition-colors"
              onclick={handleCopy}
            >
              <span class="i-carbon-copy text-base"></span>
              Copy
            </button>
            <button
              class="w-full px-3 py-1.5 text-left text-sm text-red-400 hover:bg-surface-light flex items-center gap-2 transition-colors"
              onclick={handleDelete}
            >
              <span class="i-carbon-trash-can text-base"></span>
              Delete for you
            </button>
          </div>
        {/if}
      </div>
      <!-- Reaction button -->
      {#if onreact}
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
    {/if}

    <div class="max-w-[85%] min-w-0 relative {message.reactions && Object.keys(message.reactions).length > 0 ? 'mb-4' : ''}">
      <div class="px-3 py-1.5 text-sm overflow-hidden message-content {getBubbleClass(message.isMine, styleFirst, styleLast)} {message.isMine ? 'prose-invert' : ''}">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized with DOMPurify -->
        {@html htmlContent}
      </div>

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

    <!-- Action buttons - after message for their messages -->
    {#if !message.isMine && (isHovered || showEmojiPicker || showMenu)}
      <!-- Reaction button -->
      {#if onreact}
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
      <!-- Menu button -->
      <div class="relative">
        <button
          class="w-7 h-7 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
          onclick={() => showMenu = !showMenu}
          aria-label="Message menu"
        >
          <span class="i-carbon-overflow-menu-vertical text-sm"></span>
        </button>
        {#if showMenu}
          <div class="absolute left-0 bottom-full mb-1 z-30 bg-surface border border-surface-lighter rounded-lg py-1 shadow-xl min-w-32">
            <button
              class="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-surface-light flex items-center gap-2 transition-colors"
              onclick={handleCopy}
            >
              <span class="i-carbon-copy text-base"></span>
              Copy
            </button>
            <button
              class="w-full px-3 py-1.5 text-left text-sm text-red-400 hover:bg-surface-light flex items-center gap-2 transition-colors"
              onclick={handleDelete}
            >
              <span class="i-carbon-trash-can text-base"></span>
              Delete for you
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<!-- Click outside to close emoji picker or menu -->
{#if showEmojiPicker}
  <button
    class="fixed inset-0 z-20 bg-transparent border-none cursor-default"
    onclick={closePicker}
    aria-label="Close picker"
  ></button>
{/if}
{#if showMenu}
  <button
    class="fixed inset-0 z-20 bg-transparent border-none cursor-default"
    onclick={closeMenu}
    aria-label="Close menu"
  ></button>
{/if}

<style>
  /* Markdown content styling - prevent overflow */
  .message-content {
    overflow-wrap: break-word;
    word-wrap: break-word;
    word-break: break-word;
    hyphens: auto;
    max-width: 100%;
  }
  .message-content :global(*) {
    max-width: 100%;
    overflow-wrap: break-word;
    word-wrap: break-word;
  }
  .message-content :global(p) {
    margin: 0;
  }
  .message-content :global(p + p) {
    margin-top: 0.5em;
  }
  .message-content :global(a) {
    text-decoration: underline;
    word-break: break-all;
  }
  .message-content :global(a:hover) {
    opacity: 0.8;
  }
  .message-content :global(code) {
    background: rgba(0, 0, 0, 0.2);
    padding: 0.1em 0.3em;
    border-radius: 0.25em;
    font-size: 0.9em;
    font-family: ui-monospace, monospace;
    word-break: break-all;
  }
  .message-content :global(pre) {
    background: rgba(0, 0, 0, 0.3);
    padding: 0.5em;
    border-radius: 0.5em;
    overflow-x: auto;
    margin: 0.5em 0;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .message-content :global(pre code) {
    background: none;
    padding: 0;
    word-break: break-all;
  }
  .message-content :global(blockquote) {
    border-left: 3px solid currentColor;
    margin: 0.5em 0;
    padding-left: 0.75em;
    opacity: 0.85;
  }
  .message-content :global(ul),
  .message-content :global(ol) {
    margin: 0.25em 0;
    padding-left: 1.5em;
  }
  .message-content :global(li) {
    margin: 0.1em 0;
  }
  .message-content :global(strong) {
    font-weight: 600;
  }
  .message-content :global(em) {
    font-style: italic;
  }
  .message-content :global(h1),
  .message-content :global(h2),
  .message-content :global(h3),
  .message-content :global(h4),
  .message-content :global(h5),
  .message-content :global(h6) {
    font-weight: 600;
    margin: 0.5em 0 0.25em;
  }
  .message-content :global(h1) { font-size: 1.25em; }
  .message-content :global(h2) { font-size: 1.15em; }
  .message-content :global(h3) { font-size: 1.1em; }
  .message-content :global(hr) {
    border: none;
    border-top: 1px solid currentColor;
    opacity: 0.3;
    margin: 0.5em 0;
  }
  .message-content :global(img) {
    max-width: 100%;
    border-radius: 0.5em;
  }
  .message-content :global(table) {
    border-collapse: collapse;
    margin: 0.5em 0;
    font-size: 0.9em;
  }
  .message-content :global(th),
  .message-content :global(td) {
    border: 1px solid currentColor;
    padding: 0.25em 0.5em;
    opacity: 0.7;
  }
  .message-content :global(th) {
    opacity: 1;
    font-weight: 600;
  }
  /* Link colors - default for received messages */
  .message-content :global(a) {
    color: #60a5fa; /* blue-400 */
  }
  /* Inverted for sent messages */
  .message-content.prose-invert :global(a) {
    color: white;
  }
</style>
