<script lang="ts">
  import { identity } from '../lib/identity'
  import { chats, type ChatSession } from '../lib/chat'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  import ChatListItem from './ChatListItem.svelte'

  interface Props {
    selectedChatId: string | null
    onSelectChat: (chat: ChatSession) => void
    onNewChat: () => void
    onSettings: () => void
    onlogout: () => void
  }

  let { selectedChatId, onSelectChat, onNewChat, onSettings, onlogout }: Props = $props()

  let showUserMenu = $state(false)

  function toggleUserMenu() {
    showUserMenu = !showUserMenu
  }

  function closeUserMenu() {
    showUserMenu = false
  }

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
    <div class="flex items-center gap-2 select-none">
      <img src="/iris-logo.png" alt="Iris" class="w-8 h-8" draggable="false" />
      <h1 class="text-xl font-bold">
        <span class="text-primary">iris</span> chat
      </h1>
    </div>
    <div class="relative">
      <button
        class="flex items-center gap-2 cursor-pointer bg-transparent border-none p-0"
        onclick={toggleUserMenu}
      >
        <Avatar pubkey={$identity?.pubkey || ''} size={32} />
        <span class="i-carbon-chevron-down text-gray-400 text-xs"></span>
      </button>

      {#if showUserMenu}
        <div
          class="absolute right-0 top-full mt-1 w-48 bg-surface border border-surface-lighter rounded-lg shadow-xl z-50"
        >
          <button
            class="btn-ghost w-full text-left text-sm flex items-center gap-2"
            onclick={() => { onSettings(); closeUserMenu(); }}
          >
            <span class="i-carbon-settings"></span>
            Settings
          </button>
          <button
            class="btn-ghost w-full text-left text-sm flex items-center gap-2"
            onclick={() => { onlogout(); closeUserMenu(); }}
          >
            <span class="i-carbon-logout"></span>
            Logout
          </button>
        </div>
      {/if}
    </div>
  </header>

  {#if showUserMenu}
    <button
      class="fixed inset-0 z-40 bg-transparent border-none cursor-default"
      onclick={closeUserMenu}
      aria-label="Close menu"
    ></button>
  {/if}

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
  <div class="flex-1 overflow-y-auto">
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
