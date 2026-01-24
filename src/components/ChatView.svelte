<script lang="ts">
  import { sendMessage, sendReaction, deleteChat, type ChatSession, currentChat } from '../lib/chat'
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
  let messagesContainer = $state<HTMLDivElement | null>(null)
  let inputRef = $state<HTMLTextAreaElement | null>(null)
  let showMenu = $state(false)

  function handleDelete() {
    deleteChat(chat)
    onleave()
  }

  function handleSend() {
    if (!messageText.trim()) return

    const text = messageText.trim()
    messageText = ''

    sendMessage(chat, text)

    requestAnimationFrame(() => inputRef?.focus())
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    } else if (e.key === 'Escape') {
      inputRef?.blur()
    }
  }

  async function handleReact(messageId: string, emoji: string) {
    try {
      await sendReaction(chat, messageId, emoji)
    } catch (e) {
      console.error('Failed to send reaction:', e)
    }
  }

  // Auto-scroll to bottom when new messages arrive
  $effect(() => {
    if (messagesContainer && $currentChat?.messages.length) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight
    }
  })

  // Autofocus input when chat opens or changes
  $effect(() => {
    chat.id
    if (inputRef) {
      inputRef.focus()
    }
  })

  let messages = $derived($currentChat?.messages || chat.messages)
</script>

<div class="flex-1 flex flex-col min-h-0">
  <!-- Header -->
  <header class="h-16 px-4 flex items-center gap-3 border-b border-surface-lighter flex-shrink-0 bg-[#0a0a0a]">
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

    <!-- Menu -->
    <div class="relative">
      <button
        class="p-2 rounded-full text-gray-400 hover:bg-surface-light hover:text-white transition-colors"
        onclick={() => showMenu = !showMenu}
        aria-label="Chat menu"
      >
        <span class="i-carbon-overflow-menu-horizontal text-xl"></span>
      </button>

      {#if showMenu}
        <div class="absolute right-0 top-full mt-1 w-40 bg-surface border border-surface-lighter rounded-lg shadow-xl z-50">
          <button
            class="btn-ghost w-full text-left text-red-400 flex items-center gap-2"
            onclick={handleDelete}
          >
            <span class="i-carbon-trash-can"></span>
            Delete chat
          </button>
        </div>
      {/if}
    </div>
  </header>

  {#if showMenu}
    <button
      class="fixed inset-0 z-10 bg-transparent border-none cursor-default"
      onclick={() => showMenu = false}
      aria-label="Close menu"
    ></button>
  {/if}

  <!-- Messages - scrollable -->
  <div
    bind:this={messagesContainer}
    class="flex-1 overflow-y-auto p-4 min-h-0"
  >
    <!-- Invite started system message -->
    {#if chat.inviteId}
      <div class="text-center py-2 mb-2">
        <p class="text-sm text-gray-500">
          <span class="text-primary"><Name pubkey={chat.recipientPubkey} /></span>
          started the chat via invite link{#if chat.inviteLabel} <span class="text-gray-400">"{chat.inviteLabel}"</span>{/if}
        </p>
      </div>
    {/if}

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
        {@const prevHasReactions = prevMsg?.reactions && Object.keys(prevMsg.reactions).length > 0}
        {@const hasReactions = message.reactions && Object.keys(message.reactions).length > 0}
        <MessageBubble {message} {isFirst} {isLast} {prevHasReactions} {hasReactions} onreact={handleReact} />
      {/each}
    {/if}
  </div>

  <!-- Input - flex-shrink-0 keeps it at bottom -->
  <div class="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-surface-lighter flex-shrink-0 bg-[#0a0a0a]">
    <div class="flex gap-2 items-end">
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        bind:this={inputRef}
        bind:value={messageText}
        onkeydown={handleKeydown}
        placeholder="Type a message..."
        class="input-field flex-1 resize-none min-h-[44px] max-h-32 py-3"
        rows="1"
        autofocus
      ></textarea>
      <button
        class="btn-primary w-11 h-11 p-0 flex items-center justify-center flex-shrink-0"
        onclick={handleSend}
        disabled={!messageText.trim()}
        aria-label="Send"
      >
        <span class="i-carbon-send text-xl"></span>
      </button>
    </div>
  </div>
</div>
