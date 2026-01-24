<script lang="ts">
  import { onMount } from 'svelte'
  import LoginView from './components/LoginView.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import MainContent from './components/MainContent.svelte'
  import SettingsView from './components/SettingsView.svelte'
  import NotificationPrompt from './components/NotificationPrompt.svelte'
  import { identity, autoLogin, logout } from './lib/identity'
  import { parseInviteFromHash, currentChat, leaveChat, loadChatsFromStorage, clearChatData, chats } from './lib/chat'
  import type { ChatSession } from './lib/chat'
  import { get } from 'svelte/store'

  // View routing
  type View = 'chat' | 'settings'

  let loggedIn = $state(false)
  let initializing = $state(true)
  let selectedChat = $state<ChatSession | null>(null)
  let currentView = $state<View>('chat')
  // Mobile: which panel to show - 'sidebar' or 'main'
  let mobileView = $state<'sidebar' | 'main'>('sidebar')

  // Parse view from URL hash
  function getViewFromHash(): View {
    const hash = window.location.hash
    if (hash === '#settings') return 'settings'
    return 'chat'
  }

  // Update URL hash without triggering popstate
  function setHashSilently(hash: string) {
    const url = new URL(window.location.href)
    url.hash = hash
    history.replaceState(null, '', url)
  }

  // Navigate to a view with history
  function navigateTo(view: View, push = true) {
    currentView = view
    const hash = view === 'settings' ? '#settings' : ''
    if (push) {
      history.pushState({ view }, '', hash || window.location.pathname)
    } else {
      setHashSilently(hash)
    }
  }

  onMount(async () => {
    // Check for invite in URL hash (invite hashes start with #invite-)
    const hashInvite = parseInviteFromHash()

    // Set initial view from URL hash (only if not an invite)
    if (!hashInvite) {
      currentView = getViewFromHash()
      if (currentView === 'settings') {
        mobileView = 'main'
      }
    }

    // Listen for browser back/forward
    const handlePopState = () => {
      const view = getViewFromHash()
      currentView = view
      mobileView = view === 'settings' ? 'main' : 'sidebar'
    }
    window.addEventListener('popstate', handlePopState)

    // Listen for notification clicks from service worker
    const handleServiceWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'NOTIFICATION_CLICK' && event.data?.chatId) {
        const chatMap = get(chats)
        const chat = chatMap.get(event.data.chatId)
        if (chat) {
          selectedChat = chat
          currentChat.set(chat)
          currentView = 'chat'
          mobileView = 'main'
        }
      }
    }
    navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage)

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

    return () => {
      window.removeEventListener('popstate', handlePopState)
      navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage)
    }
  })

  async function handleLogin() {
    // Load saved chats from IndexedDB
    await loadChatsFromStorage()
    loggedIn = true
  }

  function handleSelectChat(chat: ChatSession) {
    selectedChat = chat
    currentChat.set(chat)
    if (currentView !== 'chat') {
      navigateTo('chat')
    }
    mobileView = 'main'
  }

  function handleChatJoined(event: CustomEvent<{ chat: ChatSession }>) {
    selectedChat = event.detail.chat
    currentChat.set(event.detail.chat)
    if (currentView !== 'chat') {
      navigateTo('chat')
    }
    mobileView = 'main'
  }

  function handleNewChat() {
    selectedChat = null
    currentChat.set(null)
    if (currentView !== 'chat') {
      navigateTo('chat')
    }
    mobileView = 'main'
  }

  function handleBack() {
    selectedChat = null
    currentChat.set(null)
    if (currentView !== 'chat') {
      navigateTo('chat')
    }
    mobileView = 'sidebar'
  }

  function handleSettings() {
    navigateTo('settings')
    mobileView = 'main'
  }

  function handleSettingsBack() {
    history.back()
  }

  async function handleLogout() {
    logout()
    leaveChat()
    await clearChatData()
    loggedIn = false
    selectedChat = null
    navigateTo('chat', false)
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
    <div class="h-full flex flex-col">
      <!-- Notification prompt -->
      <NotificationPrompt />

      <!-- Main app layout -->
      <div class="flex flex-1 min-h-0">
        <!-- Sidebar - always visible on desktop, conditionally on mobile -->
        <div class="
          w-full md:w-80 lg:w-96 flex-shrink-0 h-full
          {mobileView === 'sidebar' ? 'block' : 'hidden'} md:block
        ">
          <Sidebar
            selectedChatId={selectedChat?.id || null}
            onSelectChat={handleSelectChat}
            onNewChat={handleNewChat}
            onSettings={handleSettings}
            onlogout={handleLogout}
          />
        </div>

        <!-- Main content - always visible on desktop, conditionally on mobile -->
        <div class="
          flex-1 h-full bg-[#0a0a0a]
          {mobileView === 'main' ? 'block' : 'hidden'} md:block
        ">
          {#if currentView === 'settings'}
            <SettingsView onBack={handleSettingsBack} />
          {:else}
            <MainContent
              chat={selectedChat}
              onChatJoined={handleChatJoined}
              onBack={handleBack}
              showBackButton={mobileView === 'main'}
            />
          {/if}
        </div>
      </div>
    </div>
  {/if}
</main>
