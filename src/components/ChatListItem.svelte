<script lang="ts">
  import type { ChatSession } from '../lib/chat'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'

  interface Props {
    chat: ChatSession
    onopen: () => void
  }

  let { chat, onopen }: Props = $props()

  let lastMessage = $derived(chat.messages[chat.messages.length - 1])

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

<button
  class="w-full p-3 hover:bg-surface-light flex items-center gap-3 transition-colors text-left"
  onclick={onopen}
>
  <Avatar pubkey={chat.recipientPubkey} size={48} />

  <div class="flex-1 min-w-0 leading-tight">
    <div class="flex items-center justify-between gap-2">
      <span class="font-medium text-sm"><Name pubkey={chat.recipientPubkey} /></span>
      {#if lastMessage}
        <span class="text-xs text-gray-500 flex-shrink-0">{formatTime(lastMessage.timestamp)}</span>
      {/if}
    </div>
    {#if lastMessage}
      <div class="text-sm text-gray-400 truncate flex items-center gap-0.5">
        {#if lastMessage.isMine}
          {#if lastMessage.status === 'seen'}
            <span class="relative inline-block w-4 h-3 flex-shrink-0">
              <span class="i-carbon-checkmark text-xs absolute top-0 left-0 text-primary"></span>
              <span class="i-carbon-checkmark absolute top-0 left-[5px] text-[#0a0a0a] check-outline-size"></span>
              <span class="i-carbon-checkmark text-xs absolute top-0 left-[5px] text-primary"></span>
            </span>
          {:else if lastMessage.status === 'delivered'}
            <span class="relative inline-block w-4 h-3 flex-shrink-0">
              <span class="i-carbon-checkmark text-xs absolute top-0 left-0 text-gray-500"></span>
              <span class="i-carbon-checkmark absolute top-0 left-[5px] text-[#0a0a0a] check-outline-size"></span>
              <span class="i-carbon-checkmark text-xs absolute top-0 left-[5px] text-gray-500"></span>
            </span>
          {:else}
            <span class="relative inline-block w-4 h-3 text-gray-500 flex-shrink-0">
              <span class="i-carbon-checkmark text-xs absolute top-0 left-[5px]"></span>
            </span>
          {/if}
        {/if}
        <span class="truncate">{lastMessage.isMine ? 'You: ' : ''}{lastMessage.content}</span>
      </div>
    {:else}
      <div class="text-sm text-gray-500 italic">No messages yet</div>
    {/if}
  </div>
</button>

<style>
  .check-outline-size {
    font-size: 14px;
    margin-top: -1px;
    margin-left: -1px;
  }
</style>
