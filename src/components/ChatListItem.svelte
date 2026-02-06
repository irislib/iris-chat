<script lang="ts">
  import type { ChatSession } from '../lib/chat'
  import { isTyping } from '../lib/typingState'
  import { countUnseenMessages, formatUnseenCount } from '../lib/unseenCount'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  import StatusIndicator from './StatusIndicator.svelte'

  interface Props {
    chat: ChatSession
    onopen: () => void
    showRequestActions?: boolean
    onaccept?: () => void
    onreject?: () => void
  }

  let { chat, onopen, showRequestActions = false, onaccept, onreject }: Props = $props()

  let lastMessage = $derived(chat.messages[chat.messages.length - 1])
  let unseenCount = $derived(countUnseenMessages(chat.messages))
  let unseenCountLabel = $derived(formatUnseenCount(unseenCount))

  function formatTime(timestamp: number): string {
    const date = new Date(timestamp)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()

    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
</script>

<div class="w-full p-3 hover:bg-surface-light flex items-center gap-3 transition-colors">
  <button
    class="flex items-center gap-3 flex-1 min-w-0 text-left bg-transparent border-none p-0 cursor-pointer"
    onclick={onopen}
  >
    <Avatar pubkey={chat.recipientPubkey} size={48} />

    <div class="flex-1 min-w-0 leading-tight">
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium text-sm truncate"><Name pubkey={chat.recipientPubkey} /></span>
        <div class="flex flex-col items-end flex-shrink-0 gap-0.5">
          {#if lastMessage}
            <div class="flex items-center gap-1.5">
              {#if unseenCount > 0}
                <span
                  data-testid="unread-indicator"
                  class="min-w-5 h-5 px-1.5 rounded-full bg-primary text-white text-xs flex items-center justify-center flex-shrink-0"
                >
                  {unseenCountLabel}
                </span>
              {/if}
              <span class="text-xs text-gray-500">{formatTime(lastMessage.timestamp)}</span>
            </div>
            {#if lastMessage.isMine}
              <StatusIndicator status={lastMessage.status} />
            {/if}
          {/if}
        </div>
      </div>
      {#if $isTyping.get(chat.id)}
        <div class="text-sm text-primary">typing...</div>
      {:else if lastMessage}
        <div class="text-sm text-gray-400 truncate">
          {lastMessage.isMine ? 'You: ' : ''}{lastMessage.content}
        </div>
      {:else}
        <div class="text-sm text-gray-500 italic">No messages yet</div>
      {/if}
    </div>
  </button>

  {#if showRequestActions}
    <div class="flex gap-2 flex-shrink-0">
      <button
        class="btn-primary text-xs px-3 py-2"
        onclick={(e) => {
          e.stopPropagation()
          onaccept?.()
        }}
        disabled={!onaccept}
        data-testid="request-accept"
      >
        Accept
      </button>
      <button
        class="btn-ghost text-xs px-3 py-2 text-red-400"
        onclick={(e) => {
          e.stopPropagation()
          onreject?.()
        }}
        disabled={!onreject}
        data-testid="request-reject"
      >
        Reject
      </button>
    </div>
  {/if}
</div>
