<script lang="ts">
  import { identity } from '../lib/identity'
  import { chats, type ChatSession } from '../lib/chat'
  import { relayStore } from '../lib/relayStore'
  import Avatar from './Avatar.svelte'
  import ChatListItem from './ChatListItem.svelte'
  import ConnectivityIndicator from './ConnectivityIndicator.svelte'

  interface Props {
    selectedChatId: string | null
    onSelectChat: (chat: ChatSession) => void
    onNewChat: () => void
    onSettings: () => void
  }

  let { selectedChatId, onSelectChat, onNewChat, onSettings }: Props = $props()

  let showConnectivity = $derived($relayStore.showConnectivity)

  // Sorted chats by most recent
  let sortedChats = $derived(
    Array.from($chats.values()).sort((a, b) => {
      const aTime = a.messages[a.messages.length - 1]?.timestamp || 0
      const bTime = b.messages[b.messages.length - 1]?.timestamp || 0
      return bTime - aTime
    })
  )
</script>

<div class="h-full flex flex-col bg-surface border-r border-surface-lighter">
  <!-- Header -->
  <header class="h-16 px-4 flex items-center justify-between border-b border-surface-lighter flex-shrink-0">
    <button
      class="flex items-center gap-2 select-none bg-transparent border-none p-0 cursor-pointer hover:opacity-80 transition-opacity"
      onclick={onNewChat}
    >
      <img src="/iris-logo.png" alt="Iris" class="w-8 h-8" draggable="false" />
      <h1 class="text-xl font-bold">
        <span class="text-primary">iris</span> chat
      </h1>
    </button>
    <div class="flex items-center gap-1">
      {#if showConnectivity}
        <ConnectivityIndicator onclick={onSettings} />
      {/if}
      <button
        class="cursor-pointer bg-transparent border-none p-0 hover:opacity-80 transition-opacity"
        onclick={onSettings}
        aria-label="Settings"
      >
        <Avatar pubkey={$identity?.pubkey || ''} size={32} />
      </button>
    </div>
  </header>

  <!-- New Chat Button -->
  <div class="p-3 border-b border-surface-lighter flex-shrink-0">
    <button
      class="btn-primary w-full flex items-center justify-center gap-2"
      onclick={onNewChat}
    >
      <span class="i-carbon-add"></span>
      New Chat
    </button>
  </div>

  <!-- Chat List -->
  <div class="flex-1 overflow-y-auto overscroll-contain">
    {#if sortedChats.length > 0}
      {#each sortedChats as chat (chat.id)}
        <div class="{selectedChatId === chat.id ? 'bg-surface-light' : ''}">
          <ChatListItem {chat} onopen={() => onSelectChat(chat)} />
        </div>
      {/each}
    {:else}
      <div class="text-center py-8 px-4">
        <div class="i-carbon-chat text-4xl text-gray-600 mx-auto mb-2"></div>
        <p class="text-gray-400 text-sm">No chats yet</p>
      </div>
    {/if}
  </div>
</div>
