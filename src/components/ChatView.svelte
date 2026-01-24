<script lang="ts">
  import { tick } from 'svelte'
  import { sendMessage, type ChatSession, currentChat } from '../lib/chat'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  import MessageBubble from './MessageBubble.svelte'

  interface Props {
    chat: ChatSession
    onleave: () => void
    showBackButton?: boolean
  }

  let { chat, onleave, showBackButton = true }: Props = $props()

  let messageText = $state('')
  let sending = $state(false)
  let messagesContainer = $state<HTMLDivElement | null>(null)
  let inputRef = $state<HTMLTextAreaElement | null>(null)

  async function handleSend() {
    if (!messageText.trim() || sending) return

    const text = messageText.trim()
    messageText = ''
    sending = true

    try {
      await sendMessage(chat, text)
    } catch (e) {
      console.error('Failed to send message:', e)
      messageText = text // Restore on failure
    } finally {
      sending = false
      await tick()
      inputRef?.focus()
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    } else if (e.key === 'Escape') {
      inputRef?.blur()
    }
  }

  // Auto-scroll to bottom when new messages arrive
  $effect(() => {
    if (messagesContainer && $currentChat?.messages.length) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight
    }
  })

  // Get messages from current chat store for reactivity
  let messages = $derived($currentChat?.messages || chat.messages)
</script>

<div class="h-full flex flex-col">
  <!-- Header -->
  <header class="h-16 px-4 flex items-center gap-3 border-b border-surface-lighter flex-shrink-0">
    {#if showBackButton}
      <button
        class="btn-ghost p-2 rounded-full"
        onclick={onleave}
        aria-label="Back"
      >
        <span class="i-carbon-arrow-left text-xl"></span>
      </button>
    {/if}

    <Avatar pubkey={chat.recipientPubkey} size={40} />

    <div class="flex-1 min-w-0">
      <p class="font-medium">
        <Name pubkey={chat.recipientPubkey} />
      </p>
    </div>
  </header>

  <!-- Messages -->
  <div
    bind:this={messagesContainer}
    class="flex-1 overflow-y-auto p-4"
  >
    {#if messages.length === 0}
      <div class="text-center py-8">
        <div class="i-carbon-locked text-4xl text-primary mx-auto mb-2"></div>
        <p class="text-gray-400">End-to-end encrypted</p>
        <p class="text-sm text-gray-500">Messages are secured with double ratchet encryption</p>
      </div>
    {:else}
      {#each messages as message, i (message.id)}
        {@const prevMsg = messages[i - 1]}
        {@const nextMsg = messages[i + 1]}
        {@const isFirst = prevMsg?.isMine !== message.isMine}
        {@const isLast = nextMsg?.isMine !== message.isMine}
        <MessageBubble {message} {isFirst} {isLast} />
      {/each}
    {/if}
  </div>

  <!-- Input -->
  <div class="p-4 border-t border-surface-lighter">
    <div class="flex gap-2 items-end">
      <textarea
        bind:this={inputRef}
        bind:value={messageText}
        onkeydown={handleKeydown}
        placeholder="Type a message..."
        class="input-field flex-1 resize-none min-h-[44px] max-h-32 py-3"
        rows="1"
        disabled={sending}
        autofocus
      ></textarea>
      <button
        class="btn-primary w-11 h-11 p-0 flex items-center justify-center flex-shrink-0"
        onclick={handleSend}
        disabled={!messageText.trim() || sending}
        aria-label="Send"
      >
        {#if sending}
          <div class="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
        {:else}
          <span class="i-carbon-send text-xl"></span>
        {/if}
      </button>
    </div>
  </div>
</div>
