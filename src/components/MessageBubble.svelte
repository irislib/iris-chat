<script lang="ts">
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
  import type { ChatMessage } from '../lib/chat'
  import { FILE_LINK_REGEX, parseFileLink } from '../lib/hashtree'
  import { openMediaModal } from '../lib/mediaModal'
  import FileAttachment from './FileAttachment.svelte'
  import StatusIndicator from './StatusIndicator.svelte'
  import Name from './Name.svelte'
  import MessageInfoModal from './MessageInfoModal.svelte'
  import EmojiPicker from './EmojiPicker.svelte'

  interface Props {
    message: ChatMessage
    isFirst: boolean
    isLast: boolean
    prevHasReactions?: boolean
    hasReactions?: boolean
    showSenderName?: boolean
    senderName?: string
    senderPubkey?: string
    myPubkey?: string | null
    recipientPubkey?: string | null
    groupMembers?: string[]
    replyToMessage?: ChatMessage | null
    onreact?: (messageId: string, emoji: string) => Promise<void>
    ondelete?: (messageId: string) => void
    onreply?: (message: ChatMessage) => void
  }

  let {
    message,
    isFirst,
    isLast,
    prevHasReactions = false,
    hasReactions = false,
    showSenderName = false,
    senderName,
    senderPubkey,
    myPubkey = null,
    recipientPubkey = null,
    groupMembers = [],
    replyToMessage = null,
    onreact,
    ondelete,
    onreply,
  }: Props = $props()

  function handleReply() {
    onreply?.(message)
  }

  function scrollToMessage(id: string) {
    const el = document.getElementById(`msg-${id}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('highlight-message')
      setTimeout(() => el.classList.remove('highlight-message'), 2000)
    }
  }

  // For styling: treat as visually first/last if adjacent to reactions
  let styleFirst = $derived(isFirst || prevHasReactions)
  let styleLast = $derived(isLast || hasReactions)

  let showEmojiPicker = $state(false)
  let showExtendedPicker = $state(false)
  let showMenu = $state(false)
  let showInfoModal = $state(false)
  let openUpward = $state(true)
  let openLeft = $state(false)
  let menuButton = $state<HTMLButtonElement | null>(null)
  let menuContent = $state<HTMLDivElement | null>(null)
  let emojiContainer = $state<HTMLDivElement | null>(null)


  function checkDirection(e: MouseEvent) {
    const button = (e.currentTarget as HTMLElement)
    const rect = button.getBoundingClientRect()
    const spaceAbove = rect.top
    const spaceBelow = window.innerHeight - rect.bottom
    const pickerWidth = 288
    const viewportPadding = 8
    const rightFits = rect.left + pickerWidth <= window.innerWidth - viewportPadding
    const leftFits = rect.right - pickerWidth >= viewportPadding
    const spaceLeft = rect.right - viewportPadding
    const spaceRight = window.innerWidth - viewportPadding - rect.left
    // Prefer opening toward the roomier side, require a minimum buffer above
    openUpward = spaceAbove > 180 && spaceAbove >= spaceBelow
    // Prefer a side that fully fits. If neither does, use the side with more room.
    openLeft = !rightFits && (leftFits || spaceLeft > spaceRight)
  }

  const quickEmojis = ['❤️', '👍', '😂', '😮', '😢', '🙏']

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message.content)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = message.content
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        document.execCommand('copy')
      } catch {
        // ignore
      } finally {
        document.body.removeChild(textarea)
      }
    }
    showMenu = false
  }

  function handleDelete() {
    ondelete?.(message.id)
    showMenu = false
  }

  function handleInfo() {
    showInfoModal = true
    showMenu = false
  }

  function closeMenu() {
    showMenu = false
  }

  // Configure marked for GFM (GitHub Flavored Markdown)
  const renderer = new marked.Renderer()
  const originalLinkRenderer = renderer.link.bind(renderer)
  renderer.link = function (token) {
    const html = originalLinkRenderer(token)
    // Add target="_blank" and rel="noopener noreferrer" to all links
    return html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ')
  }
  marked.setOptions({
    gfm: true,
    breaks: true, // Convert \n to <br>
    renderer,
  })

  // Extract file links from content
  let fileLinks = $derived.by(() => {
    const links: { nhash: string; filename: string }[] = []
    const regex = new RegExp(FILE_LINK_REGEX.source, 'gi')
    let match
    while ((match = regex.exec(message.content)) !== null) {
      // Decode URL-encoded filename
      links.push({ nhash: match[1], filename: decodeURIComponent(match[2]) })
    }
    return links
  })

  // Remove file links from content for display (they'll be rendered separately)
  let textContent = $derived.by(() => {
    return message.content.replace(FILE_LINK_REGEX, '').trim()
  })

  // Render markdown content safely
  let htmlContent = $derived.by(() => {
    if (!textContent) return ''
    const raw = marked.parse(textContent, { async: false }) as string
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target'], // Allow target="_blank" on links
    })
  })

  let showCombinedTextAndFiles = $derived(Boolean(htmlContent && fileLinks.length > 0))

  // Check if content has any markdown formatting
  let hasMarkdown = $derived.by(() => {
    const content = textContent
    // Check for common markdown patterns
    return /[*_`#\[\]!\-]/.test(content) ||
           /```/.test(content) ||
           /\n/.test(content)
  })

  async function handleReact(emoji: string) {
    showEmojiPicker = false
    showExtendedPicker = false
    await onreact?.(message.id, emoji)
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (showMenu) {
        showMenu = false
      }
      if (showInfoModal) {
        showInfoModal = false
      }
    }
  }

  function closePicker() {
    showEmojiPicker = false
    showExtendedPicker = false
  }

  // Listen for escape key
  $effect(() => {
    if (showMenu) {
      document.addEventListener('keydown', handleKeydown)
      return () => document.removeEventListener('keydown', handleKeydown)
    }
  })

  function handleDocumentPointerDown(event: MouseEvent) {
    const target = event.target as Node
    if (showMenu) {
      const insideMenu = menuContent?.contains(target) || menuButton?.contains(target)
      if (!insideMenu) showMenu = false
    }
    if (showEmojiPicker && !showExtendedPicker) {
      const insideEmoji = emojiContainer?.contains(target)
      if (!insideEmoji) closePicker()
    }
  }

  $effect(() => {
    if (!showMenu && !showEmojiPicker) return
    document.addEventListener('mousedown', handleDocumentPointerDown)
    return () => document.removeEventListener('mousedown', handleDocumentPointerDown)
  })

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  function getMarkdownImageName(src: string, alt: string | null): string {
    const trimmedAlt = alt?.trim()
    if (trimmedAlt) return trimmedAlt

    try {
      const url = new URL(src, window.location.href)
      const name = url.pathname.split('/').filter(Boolean).pop()
      if (name) return decodeURIComponent(name)
    } catch {
      // Ignore invalid URLs and fall back to default label.
    }

    return 'Image'
  }

  function handleMessageContentClick(event: MouseEvent) {
    const target = event.target
    const current = event.currentTarget
    if (!(target instanceof HTMLElement) || !(current instanceof HTMLElement)) return

    const imageEl = target.closest('img')
    if (!(imageEl instanceof HTMLImageElement)) return
    if (!current.contains(imageEl)) return

    const src = imageEl.currentSrc || imageEl.src
    if (!src) return

    event.preventDefault()
    event.stopPropagation()
    openMediaModal(src, getMarkdownImageName(src, imageEl.getAttribute('alt')), 'image')
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

  let actionsVisible = $derived(showEmojiPicker || showExtendedPicker || showMenu)
</script>

<div class="{styleFirst ? 'mt-3' : 'mt-0.5'} {actionsVisible ? 'relative z-50' : ''}" id="msg-{message.id}">
  {#if isFirst && showSenderName && (senderName || senderPubkey)}
    <div class="flex items-center gap-2 mb-1 {message.isMine ? 'justify-end' : ''}">
      <span class="text-xs text-gray-400 font-medium">
        {#if senderPubkey}
          <Name pubkey={senderPubkey} />
        {:else}
          {senderName}
        {/if}
      </span>
    </div>
  {/if}
  <div class="group flex min-w-0 {message.isMine ? 'justify-end' : ''}">
    <div class="flex items-center gap-1 max-w-[85%]">
      <!-- Action buttons - before message for own messages -->
      {#if message.isMine}
        <div class="{actionsVisible ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100 transition-opacity flex items-center gap-0.5 flex-shrink-0">
          {#if onreply}
            <button
              class="w-7 h-7 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
              onclick={handleReply}
              aria-label="Reply"
            >
              <span class="i-carbon-reply text-sm"></span>
            </button>
          {/if}
          <div class="relative">
            <button
              class="w-7 h-7 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
              bind:this={menuButton}
              onclick={(e) => { checkDirection(e); showMenu = !showMenu }}
              aria-label="Message menu"
            >
              <span class="i-carbon-overflow-menu-vertical text-sm"></span>
            </button>
            {#if showMenu}
              <div
                class="absolute {openLeft ? 'right-0' : 'left-0'} {openUpward ? 'bottom-full mb-1' : 'top-full mt-1'} z-50 bg-surface border border-surface-lighter rounded-lg py-1 shadow-xl min-w-32"
                bind:this={menuContent}
              >
                <button
                  class="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-surface-light flex items-center gap-2 transition-colors"
                  onclick={handleInfo}
                >
                  <span class="i-carbon-information text-base"></span>
                  Info
                </button>
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
          {#if onreact}
            <div class="relative" bind:this={emojiContainer}>
              <button
                class="w-7 h-7 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
                onclick={(e) => { checkDirection(e); showEmojiPicker = !showEmojiPicker; showExtendedPicker = false }}
                aria-label="Add reaction"
              >
                <span class="i-carbon-face-add text-sm"></span>
              </button>
              {#if showExtendedPicker}
                <EmojiPicker
                  onselect={handleReact}
                  onclose={closePicker}
                  openUp={openUpward}
                  openLeft={openLeft}
                />
              {:else if showEmojiPicker}
                <div class="absolute {openLeft ? 'right-0' : 'left-0'} {openUpward ? 'bottom-full mb-1' : 'top-full mt-1'} z-50 bg-surface border border-surface-lighter rounded-full px-1.5 py-1 flex gap-0.5 shadow-xl">
                  {#each quickEmojis as emoji}
                    <button
                      class="w-8 h-8 rounded-full hover:bg-surface-light flex items-center justify-center text-lg transition-colors"
                      onclick={() => handleReact(emoji)}
                    >
                      {emoji}
                    </button>
                  {/each}
                  <button
                    class="w-8 h-8 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
                    onclick={() => showExtendedPicker = true}
                    aria-label="More emojis"
                  >
                    <span class="i-carbon-overflow-menu-horizontal text-sm"></span>
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Message bubble -->
      <div class="flex-1 min-w-0">
        <div class="overflow-hidden">
          {#if replyToMessage || htmlContent}
            <div
              class="{getBubbleClass(message.isMine, styleFirst, styleLast)} {message.isMine ? 'prose-invert' : ''} overflow-hidden"
              data-testid="message-bubble-body"
            >
              <!-- Reply preview -->
              {#if replyToMessage}
                <button
                  class="text-xs text-left w-full px-3 py-1.5 mx-2 mt-2 border-l-2 rounded-sm cursor-pointer overflow-hidden {message.isMine ? 'border-white/40 bg-white/10 text-white/70' : 'border-primary/60 bg-primary/10 text-gray-300'}"
                  onclick={() => scrollToMessage(replyToMessage.id)}
                >
                  <div class="font-semibold mb-0.5">{replyToMessage.isMine ? 'You' : 'Them'}</div>
                  <div class="truncate">{replyToMessage.content}</div>
                </button>
              {/if}
              {#if showCombinedTextAndFiles}
                <div class="px-3 pt-1.5">
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div class="text-sm overflow-hidden message-content min-w-0" onclick={handleMessageContentClick}>
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized with DOMPurify -->
                    {@html htmlContent}
                  </div>
                </div>
                <div class="px-3 pb-1">
                  {#each fileLinks as link (link.nhash + link.filename)}
                    <FileAttachment nhash={link.nhash} filename={link.filename} isMine={message.isMine} inBubble={true} />
                  {/each}
                  <div class="flex items-center justify-end gap-1 mt-1">
                    <span class="text-[10px] {message.isMine ? 'text-white/50' : 'text-gray-500'}">{formatTime(message.timestamp)}</span>
                    {#if message.isMine}
                      <StatusIndicator status={message.status} variant="bubble" />
                    {/if}
                  </div>
                </div>
              {:else}
                <!-- Content + time (inline for short messages, wraps for long) -->
                <div class="flex flex-wrap items-end gap-x-2 px-3 {htmlContent ? 'pt-1.5' : 'pt-0.5'} pb-1">
                  {#if htmlContent}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div class="text-sm overflow-hidden message-content min-w-0" onclick={handleMessageContentClick}>
                      <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized with DOMPurify -->
                      {@html htmlContent}
                    </div>
                  {/if}
                  <div class="flex items-center gap-1 ml-auto">
                    <span class="text-[10px] {message.isMine ? 'text-white/50' : 'text-gray-500'}">{formatTime(message.timestamp)}</span>
                    {#if message.isMine}
                      <StatusIndicator status={message.status} variant="bubble" />
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          {/if}

          <!-- File attachments -->
          {#if !showCombinedTextAndFiles}
            {#each fileLinks as link (link.nhash + link.filename)}
              <FileAttachment nhash={link.nhash} filename={link.filename} isMine={message.isMine} />
            {/each}
          {/if}
        </div>

        <!-- Time + status for file-only messages -->
        {#if !htmlContent && !replyToMessage && fileLinks.length > 0}
          <div class="flex items-center justify-end gap-1 mt-0.5 mr-1">
            <span class="text-[10px] text-gray-500">{formatTime(message.timestamp)}</span>
            {#if message.isMine}
              <StatusIndicator status={message.status} />
            {/if}
          </div>
        {/if}

        <!-- Reactions -->
        {#if message.reactions && Object.keys(message.reactions).length > 0}
          <div class="flex items-center mt-0.5 px-1 {message.isMine ? '' : 'justify-end'}">
            <div class="flex gap-1">
              {#each Object.entries(message.reactions) as [emoji, users]}
                <span class="reaction px-1.5 py-0.5 bg-surface border border-surface-lighter rounded-full text-xs flex items-center gap-1 shadow-sm">
                  {emoji}
                  {#if users.length > 1}
                    <span class="text-gray-400">{users.length}</span>
                  {/if}
                </span>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <!-- Action buttons - after message for their messages -->
      {#if !message.isMine}
        <div class="{actionsVisible ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100 transition-opacity flex items-center gap-0.5 flex-shrink-0">
          {#if onreply}
            <button
              class="w-7 h-7 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
              onclick={handleReply}
              aria-label="Reply"
            >
              <span class="i-carbon-reply text-sm"></span>
            </button>
          {/if}
          {#if onreact}
            <div class="relative" bind:this={emojiContainer}>
              <button
                class="w-7 h-7 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
                onclick={(e) => { checkDirection(e); showEmojiPicker = !showEmojiPicker; showExtendedPicker = false }}
                aria-label="Add reaction"
              >
                <span class="i-carbon-face-add text-sm"></span>
              </button>
              {#if showExtendedPicker}
                <EmojiPicker
                  onselect={handleReact}
                  onclose={closePicker}
                  openUp={openUpward}
                  openLeft={openLeft}
                />
              {:else if showEmojiPicker}
                <div class="absolute {openLeft ? 'right-0' : 'left-0'} {openUpward ? 'bottom-full mb-1' : 'top-full mt-1'} z-50 bg-surface border border-surface-lighter rounded-full px-1.5 py-1 flex gap-0.5 shadow-xl">
                  {#each quickEmojis as emoji}
                    <button
                      class="w-8 h-8 rounded-full hover:bg-surface-light flex items-center justify-center text-lg transition-colors"
                      onclick={() => handleReact(emoji)}
                    >
                      {emoji}
                    </button>
                  {/each}
                  <button
                    class="w-8 h-8 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
                    onclick={() => showExtendedPicker = true}
                    aria-label="More emojis"
                  >
                    <span class="i-carbon-overflow-menu-horizontal text-sm"></span>
                  </button>
                </div>
              {/if}
            </div>
          {/if}
          <div class="relative">
            <button
              class="w-7 h-7 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
              bind:this={menuButton}
              onclick={(e) => { checkDirection(e); showMenu = !showMenu }}
              aria-label="Message menu"
            >
              <span class="i-carbon-overflow-menu-vertical text-sm"></span>
            </button>
            {#if showMenu}
              <div
                class="absolute {openLeft ? 'right-0' : 'left-0'} {openUpward ? 'bottom-full mb-1' : 'top-full mt-1'} z-50 bg-surface border border-surface-lighter rounded-lg py-1 shadow-xl min-w-32"
                bind:this={menuContent}
              >
                <button
                  class="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-surface-light flex items-center gap-2 transition-colors"
                  onclick={handleInfo}
                >
                  <span class="i-carbon-information text-base"></span>
                  Info
                </button>
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
        </div>
      {/if}
    </div>
  </div>
</div>

{#if showInfoModal}
  <MessageInfoModal
    {message}
    {myPubkey}
    {recipientPubkey}
    {groupMembers}
    onclose={() => showInfoModal = false}
  />
{/if}

<style>
  /* Highlight animation for scrolling to replied message */
  :global(.highlight-message) {
    animation: highlight-flash 2s ease-out;
  }
  @keyframes highlight-flash {
    0%, 20% { background-color: rgba(139, 92, 246, 0.2); }
    100% { background-color: transparent; }
  }

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
    cursor: zoom-in;
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
