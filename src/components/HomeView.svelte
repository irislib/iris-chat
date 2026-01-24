<script lang="ts">
  import { identity, logout } from '../lib/identity'
  import { chats, type ChatSession } from '../lib/chat'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  import ChatListItem from './ChatListItem.svelte'
  import NewChat from './NewChat.svelte'
  import JoinChat from './JoinChat.svelte'

  interface Props {
    onopenChat: (event: CustomEvent<{ chat: ChatSession }>) => void
    onlogout: () => void
  }

  let { onopenChat, onlogout }: Props = $props()

  let showUserMenu = $state(false)

  function toggleUserMenu() {
    showUserMenu = !showUserMenu
  }

  function closeUserMenu() {
    showUserMenu = false
  }

  function handleOpenChat(chat: ChatSession) {
    onopenChat(new CustomEvent('openChat', { detail: { chat } }))
  }

  function handleJoinChat(event: CustomEvent<{ chat: ChatSession }>) {
    onopenChat(new CustomEvent('openChat', { detail: { chat: event.detail.chat } }))
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

<div class="min-h-screen flex flex-col">
  <!-- Header -->
  <header class="h-16 px-4 flex items-center justify-between border-b border-surface-lighter">
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
        <span class="text-sm text-gray-300 hidden sm:block"><Name pubkey={$identity?.pubkey || ''} /></span>
        <span class="i-carbon-chevron-down text-gray-400 text-xs"></span>
      </button>

      {#if showUserMenu}
        <div
          class="absolute right-0 top-full mt-1 w-48 bg-surface border border-surface-lighter rounded-lg shadow-xl z-50"
        >
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

  <!-- Main content -->
  <div class="flex-1 flex items-center justify-center p-4">
    <div class="w-full max-w-3xl space-y-6">
      <!-- New/Join boxes -->
      <div class="grid md:grid-cols-2 gap-6">
        <NewChat onjoin={handleJoinChat} />
        <JoinChat onjoin={handleJoinChat} />
      </div>

      <!-- Chat list -->
      {#if sortedChats.length > 0}
        <div class="space-y-2 max-w-md mx-auto">
          <h2 class="text-sm text-gray-400 font-medium">Your chats</h2>
          {#each sortedChats as chat (chat.id)}
            <ChatListItem {chat} onopen={() => handleOpenChat(chat)} />
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Footer -->
  <footer class="py-4 text-center">
    <a
      href="https://github.com/irislib/iris-chat"
      target="_blank"
      rel="noopener noreferrer"
      class="text-sm text-gray-500 hover:text-gray-400"
    >
      Source
    </a>
  </footer>
</div>
