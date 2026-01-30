<script lang="ts">
  import type { Group, GroupMessage } from '../lib/groups'
  import { isTyping } from '../lib/typingState'
  import Name from './Name.svelte'
  import GroupAvatar from './GroupAvatar.svelte'
  import { getPubkey } from '../lib/identity'

  interface Props {
    group: Group
    messages: GroupMessage[]
    onopen: () => void
  }

  let { group, messages, onopen }: Props = $props()

  let lastMessage = $derived(messages[messages.length - 1])
  let myPubkey = $derived(getPubkey())

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
  <GroupAvatar picture={group.picture} size={48} />

  <div class="flex-1 min-w-0 leading-tight">
    <div class="flex items-center justify-between gap-2">
      <span class="font-medium text-sm truncate">{group.name}</span>
      {#if lastMessage}
        <span class="text-xs text-gray-500 flex-shrink-0">{formatTime(lastMessage.timestamp)}</span>
      {/if}
    </div>
    {#if $isTyping.get(`group:${group.id}`)}
      <div class="text-sm text-primary">typing...</div>
    {:else if lastMessage}
      <div class="text-sm text-gray-400 truncate">
        {#if lastMessage.isMine}
          <span>You: </span>
        {:else if lastMessage.senderPubkey}
          <span><Name pubkey={lastMessage.senderPubkey} />: </span>
        {/if}
        <span class="truncate">{lastMessage.content}</span>
      </div>
    {:else}
      <div class="text-sm text-gray-500 italic">No messages yet</div>
    {/if}
  </div>
</button>
