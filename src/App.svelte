<script lang="ts">
  import { onMount } from 'svelte'
  import LoginView from './components/LoginView.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import MainContent from './components/MainContent.svelte'
  import { identity, autoLogin, logout } from './lib/identity'
  import { parseInviteFromHash, currentChat, leaveChat, loadChatsFromStorage, clearChatData } from './lib/chat'
  import type { ChatSession } from './lib/chat'

  let loggedIn = $state(false)
  let initializing = $state(true)
  let selectedChat = $state<ChatSession | null>(null)
  // Mobile: which panel to show - 'sidebar' or 'main'
  let mobileView = $state<'sidebar' | 'main'>('sidebar')

  onMount(async () => {
    // Check for invite in URL hash
    const hashInvite = parseInviteFromHash()

    // Try to auto-login
    const isLoggedIn = await autoLogin()

    if (isLoggedIn) {
      // Load saved chats from IndexedDB
      await loadChatsFromStorage()
      loggedIn = true

      // If there's an invite in URL, show main view to handle it
      if (hashInvite) {
        mobileView = 'main'
      }
    }

    initializing = false
  })

  async function handleLogin() {
    // Load saved chats from IndexedDB
    await loadChatsFromStorage()
    loggedIn = true
  }

  function handleSelectChat(chat: ChatSession) {
    selectedChat = chat
    currentChat.set(chat)
    mobileView = 'main'
  }

  function handleChatJoined(event: CustomEvent<{ chat: ChatSession }>) {
    selectedChat = event.detail.chat
    currentChat.set(event.detail.chat)
    mobileView = 'main'
  }

  function handleNewChat() {
    selectedChat = null
    currentChat.set(null)
    mobileView = 'main'
  }

  function handleBack() {
    selectedChat = null
    currentChat.set(null)
    mobileView = 'sidebar'
  }

  async function handleLogout() {
    logout()
    leaveChat()
    await clearChatData()
    loggedIn = false
    selectedChat = null
    mobileView = 'sidebar'
  }
</script>

<main class="h-screen bg-[#121212] text-white overflow-hidden">
  {#if initializing}
    <div class="h-full flex items-center justify-center">
      <div class="text-center">
        <div class="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
        <p class="text-gray-400">Loading...</p>
      </div>
    </div>
  {:else if !loggedIn}
    <div class="h-full flex flex-col items-center justify-center p-4">
      <div class="mb-8 text-center flex flex-col items-center select-none">
        <img src="/iris-logo.png" alt="Iris" class="w-16 h-16 mb-4" draggable="false" />
        <h1 class="text-4xl font-bold">
          <span class="text-primary">iris</span> chat
        </h1>
        <p class="text-gray-400 mt-2">Secure, private messaging</p>
      </div>
      <LoginView onlogin={handleLogin} />
    </div>
  {:else}
    <!-- Main app layout -->
    <div class="h-full flex">
      <!-- Sidebar - always visible on desktop, conditionally on mobile -->
      <div class="
        w-full md:w-80 lg:w-96 flex-shrink-0 h-full
        {mobileView === 'sidebar' ? 'block' : 'hidden'} md:block
      ">
        <Sidebar
          selectedChatId={selectedChat?.id || null}
          onSelectChat={handleSelectChat}
          onNewChat={handleNewChat}
          onlogout={handleLogout}
        />
      </div>

      <!-- Main content - always visible on desktop, conditionally on mobile -->
      <div class="
        flex-1 h-full bg-[#0a0a0a]
        {mobileView === 'main' ? 'block' : 'hidden'} md:block
      ">
        <MainContent
          chat={selectedChat}
          onChatJoined={handleChatJoined}
          onBack={handleBack}
          showBackButton={mobileView === 'main'}
        />
      </div>
    </div>
  {/if}
</main>
