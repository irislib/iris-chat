<script lang="ts">
  import { onMount } from 'svelte'
  import LoginView from './components/LoginView.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import MainContent from './components/MainContent.svelte'
  import SettingsView from './components/SettingsView.svelte'
  import ProfileView from './components/ProfileView.svelte'
  import NotificationPrompt from './components/NotificationPrompt.svelte'
  import InstallPrompt from './components/InstallPrompt.svelte'
  import { identity, autoLogin, logout } from './lib/identity'
  import { parseInviteFromHash, currentChat, leaveChat, loadChatsFromStorage, clearChatData, chats, loadAndMonitorInvites, setInviteAcceptedCallback, saveSessionToStorage, initSessionManagerEvents } from './lib/chat'
  import { startMessageExpirationCleanup, stopMessageExpirationCleanup } from './lib/messageExpirationCleanup'
  import { syncDisappearingMessagesToSessionManager } from './lib/disappearingMessages'
  import type { ChatSession } from './lib/chat'
  import { loadGroupsFromStorage, groups, groupMessages, currentGroupId, setSaveSessionFn, type Group } from './lib/groups'
  import { get } from 'svelte/store'
  import { initMultiDevice, resetManagers } from './lib/privateChats'
  import { initFollowing } from './lib/following'
  import CreateGroup from './components/CreateGroup.svelte'
  import GroupChatView from './components/GroupChatView.svelte'
  import GroupDetailsView from './components/GroupDetailsView.svelte'

  // Send message to service worker
  function postToServiceWorker(message: object) {
    console.log('[app] posting to service worker:', message)
    navigator.serviceWorker?.ready.then(reg => {
      console.log('[app] service worker ready, active:', !!reg.active)
      reg.active?.postMessage(message)
    })
  }

  // View routing
  type View = 'chat' | 'settings' | 'profile' | 'createGroup' | 'groupDetails'

  let loggedIn = $state(false)
  let initializing = $state(true)
  let selectedChat = $state<ChatSession | null>(null)
  let selectedGroupId = $state<string | null>(null)
  let currentView = $state<View>('chat')
  let profilePubkey = $state<string | null>(null)
  // Mobile: which panel to show - 'sidebar' or 'main'
  let mobileView = $state<'sidebar' | 'main'>('sidebar')
  let duplicateTab = $state(false)

  // If a chat is deleted (e.g. rejected request), ensure we don't keep rendering it.
  $effect(() => {
    const chatId = selectedChat?.id
    if (!chatId) return
    if ($chats.has(chatId)) return
    selectedChat = null
    currentChat.set(null)
    if (currentView === 'chat') {
      mobileView = 'sidebar'
    }
  })

  // Notify service worker when chat is opened/closed
  $effect(() => {
    const chatId = selectedChat?.id || null
    postToServiceWorker({ type: 'CHAT_OPENED', chatId })
  })

  // Parse view from URL hash
  function getViewFromHash(): { view: View; profilePubkey?: string; groupId?: string } {
    const hash = window.location.hash
    if (hash === '#settings') return { view: 'settings' }
    if (hash.startsWith('#profile-')) {
      return { view: 'profile', profilePubkey: hash.slice(9) }
    }
    if (hash === '#create-group') return { view: 'createGroup' }
    if (hash.startsWith('#group-details-')) {
      return { view: 'groupDetails', groupId: hash.slice(15) }
    }
    if (hash.startsWith('#group-')) {
      return { view: 'chat', groupId: hash.slice(7) }
    }
    return { view: 'chat' }
  }

  // Update URL hash without triggering popstate
  function setHashSilently(hash: string) {
    const url = new URL(window.location.href)
    url.hash = hash
    history.replaceState(null, '', url)
  }

  // Navigate to a view with history
  function navigateTo(view: View, push = true, pubkey?: string, groupId?: string) {
    currentView = view
    if (view === 'profile' && pubkey) {
      profilePubkey = pubkey
    }
    let hash = ''
    if (view === 'settings') hash = '#settings'
    else if (view === 'profile' && pubkey) hash = `#profile-${pubkey}`
    else if (view === 'createGroup') hash = '#create-group'
    else if (view === 'groupDetails' && groupId) hash = `#group-details-${groupId}`
    else if (view === 'chat' && groupId) hash = `#group-${groupId}`

    if (push) {
      history.pushState({ view, pubkey, groupId }, '', hash || window.location.pathname)
    } else {
      setHashSilently(hash)
    }
  }

  // Navigate to profile
  function navigateToProfile(pubkey: string) {
    navigateTo('profile', true, pubkey)
    mobileView = 'main'
  }

  onMount(() => {
    let cleanup: (() => void) | undefined
    const stopFollowing = initFollowing()

    // Run async initialization
    ;(async () => {
    // Prevent multiple tabs - encryption state can't sync between them
    // Use sessionStorage to persist tab identity across hot reloads
    let tabId = sessionStorage.getItem('iris-tab-id')
    if (!tabId) {
      tabId = Math.random().toString(36).slice(2)
      sessionStorage.setItem('iris-tab-id', tabId)
    }
    const channel = new BroadcastChannel('iris-chat-tab')
    channel.postMessage({ type: 'ping', tabId })
    channel.onmessage = (e) => {
      if (e.data?.tabId === tabId) return // Ignore own messages
      if (e.data?.type === 'ping' && !duplicateTab) {
        channel.postMessage({ type: 'pong', tabId })
      } else if (e.data?.type === 'pong') {
        duplicateTab = true
        initializing = false
      }
    }

    // Small delay to detect existing tabs
    await new Promise(r => setTimeout(r, 100))
    if (duplicateTab) return

    // Check for invite in URL hash (invite hashes start with #invite-)
    const hashInvite = parseInviteFromHash()

    // Set initial view from URL hash (only if not an invite)
    if (!hashInvite) {
      const hashState = getViewFromHash()
      currentView = hashState.view
      if (hashState.view === 'profile' && hashState.profilePubkey) {
        profilePubkey = hashState.profilePubkey
        mobileView = 'main'
      } else if (hashState.view === 'settings') {
        mobileView = 'main'
      } else if (hashState.groupId) {
        selectedGroupId = hashState.groupId
        selectedChat = null
        currentChat.set(null)
        mobileView = 'main'
      }
    }

    // Listen for browser back/forward
    const handlePopState = () => {
      const hashState = getViewFromHash()
      currentView = hashState.view
      if (hashState.view === 'profile' && hashState.profilePubkey) {
        profilePubkey = hashState.profilePubkey
        mobileView = 'main'
      } else if (hashState.groupId && hashState.view === 'chat') {
        selectedGroupId = hashState.groupId
        selectedChat = null
        currentChat.set(null)
        mobileView = 'main'
      } else if (hashState.view === 'groupDetails' && hashState.groupId) {
        selectedGroupId = hashState.groupId
        mobileView = 'main'
      } else if (hashState.view === 'createGroup') {
        mobileView = 'main'
      } else {
        selectedGroupId = null
        mobileView = hashState.view === 'settings' ? 'main' : 'sidebar'
      }
    }
    window.addEventListener('popstate', handlePopState)

    // Listen for notification clicks from service worker
    const handleServiceWorkerMessage = (event: MessageEvent) => {
      console.log('[app] received service worker message:', event.data)
      if (event.data?.type === 'NOTIFICATION_CLICK' && event.data?.chatId) {
        const chatMap = get(chats)
        console.log('[app] looking for chat:', event.data.chatId, 'in', Array.from(chatMap.keys()))
        const chat = chatMap.get(event.data.chatId)
        if (chat) {
          console.log('[app] found chat, selecting it')
          selectedChat = chat
          currentChat.set(chat)
          currentView = 'chat'
          mobileView = 'main'
          // Tell service worker this chat is now open
          postToServiceWorker({ type: 'CHAT_OPENED', chatId: chat.id })
          // Clear any remaining notifications for this chat
          postToServiceWorker({ type: 'CLEAR_NOTIFICATION', chatId: chat.id })
        } else {
          console.log('[app] chat not found in map')
        }
      }
    }
    navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage)

    // Handle GET_OPEN_CHAT queries from service worker (via MessageChannel)
    const handleGetOpenChat = (event: MessageEvent) => {
      if (event.data?.type === 'GET_OPEN_CHAT' && event.ports[0]) {
        const chatId = document.visibilityState === 'visible' ? (selectedChat?.id || null) : null
        console.log('[app] GET_OPEN_CHAT response:', chatId)
        event.ports[0].postMessage({ chatId })
      }
    }
    navigator.serviceWorker?.addEventListener('message', handleGetOpenChat)

    // Try to auto-login
    const isLoggedIn = await autoLogin()

    if (isLoggedIn) {
      const currentIdentity = get(identity)
      if (currentIdentity?.pubkey) {
        // Subscribe ASAP so we don't miss early incoming manager events.
        initSessionManagerEvents()
        void initMultiDevice(currentIdentity.pubkey).catch((e) =>
          console.error('[app] initMultiDevice failed:', e)
        )
      }

      // Wire up groups -> chat session saving (before loading anything)
      setSaveSessionFn(saveSessionToStorage)

      // Load groups FIRST so group events have somewhere to land
      // (chat sessions subscribe to relays on load — group messages arriving
      //  before the groups store is populated are silently dropped)
      await loadGroupsFromStorage()

      // Load saved chats from IndexedDB (creates relay subscriptions)
      await loadChatsFromStorage()

      // Set callback for invite acceptance (works for both loaded and new invites)
      setInviteAcceptedCallback((chatSession) => {
        selectedChat = chatSession
        currentChat.set(chatSession)
        currentView = 'chat'
        selectedGroupId = null
        mobileView = 'main'
        // Tell service worker this chat is now open
        postToServiceWorker({ type: 'CHAT_OPENED', chatId: chatSession.id })
      })

      // Load and monitor saved invites
      await loadAndMonitorInvites()

      // Start message expiration cleanup and sync settings
      startMessageExpirationCleanup()
      syncDisappearingMessagesToSessionManager().catch(() => {})

      loggedIn = true

      // If there's an invite in URL, show main view to handle it
      if (hashInvite) {
        mobileView = 'main'
      }

      // Check for chat hash from notification click (e.g., #chat-{pubkey})
      const hash = window.location.hash
      if (hash.startsWith('#chat-')) {
        const chatId = hash.slice(6) // Remove '#chat-'
        const chatMap = get(chats)
        const chat = chatMap.get(chatId)
        if (chat) {
          selectedChat = chat
          currentChat.set(chat)
          mobileView = 'main'
          // Clear the hash
          history.replaceState(null, '', window.location.pathname)
          // Tell service worker this chat is now open
          postToServiceWorker({ type: 'CHAT_OPENED', chatId: chat.id })
          // Clear any notifications for this chat
          postToServiceWorker({ type: 'CLEAR_NOTIFICATION', chatId: chat.id })
        }
      }
    }

    initializing = false

    // Track visibility changes to update service worker
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && selectedChat) {
        postToServiceWorker({ type: 'CHAT_OPENED', chatId: selectedChat.id })
      } else if (document.visibilityState === 'hidden') {
        postToServiceWorker({ type: 'CHAT_OPENED', chatId: null })
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    cleanup = () => {
      window.removeEventListener('popstate', handlePopState)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage)
      navigator.serviceWorker?.removeEventListener('message', handleGetOpenChat)
      stopFollowing()
    }
    })()

    return () => cleanup?.()
  })

  async function handleLogin() {
    const currentIdentity = get(identity)
    if (currentIdentity?.pubkey) {
      // Subscribe ASAP so we don't miss early incoming manager events.
      initSessionManagerEvents()
      void initMultiDevice(currentIdentity.pubkey).catch((e) =>
        console.error('[app] initMultiDevice failed:', e)
      )
    }

    loggedIn = true

    // Wire up groups -> chat session saving (before loading anything)
    setSaveSessionFn(saveSessionToStorage)

    // Load groups FIRST (same reason as onMount — avoid race condition)
    await loadGroupsFromStorage()

    // Load saved chats from IndexedDB (creates relay subscriptions)
    await loadChatsFromStorage()

    // Set callback for invite acceptance (works for both loaded and new invites)
    setInviteAcceptedCallback((chatSession) => {
      selectedChat = chatSession
      currentChat.set(chatSession)
      currentView = 'chat'
      selectedGroupId = null
      mobileView = 'main'
      // Tell service worker this chat is now open
      postToServiceWorker({ type: 'CHAT_OPENED', chatId: chatSession.id })
    })

    // Load and monitor saved invites
    await loadAndMonitorInvites()

    // Start message expiration cleanup and sync settings
    startMessageExpirationCleanup()
    syncDisappearingMessagesToSessionManager().catch(() => {})
  }

  function handleSelectGroup(groupId: string) {
    selectedGroupId = groupId
    selectedChat = null
    currentChat.set(null)
    navigateTo('chat', true, undefined, groupId)
    mobileView = 'main'
  }

  function handleNewGroup() {
    navigateTo('createGroup')
    mobileView = 'main'
  }

  function handleGroupCreated(group: Group) {
    selectedGroupId = group.id
    selectedChat = null
    currentChat.set(null)
    navigateTo('chat', true, undefined, group.id)
    mobileView = 'main'
  }

  function handleGroupDetails() {
    if (selectedGroupId) {
      navigateTo('groupDetails', true, undefined, selectedGroupId)
    }
  }

  function handleGroupDetailsBack() {
    history.back()
  }

  function handleGroupDeleted() {
    selectedGroupId = null
    navigateTo('chat')
    mobileView = 'sidebar'
  }

  function handleSelectChat(chat: ChatSession) {
    selectedChat = chat
    currentChat.set(chat)
    selectedGroupId = null
    if (currentView !== 'chat') {
      navigateTo('chat')
    }
    mobileView = 'main'
    // Tell service worker this chat is now open (suppresses notifications)
    postToServiceWorker({ type: 'CHAT_OPENED', chatId: chat.id })
    // Clear any existing notification for this chat
    postToServiceWorker({ type: 'CLEAR_NOTIFICATION', chatId: chat.id })
  }

  function handleChatJoined(event: CustomEvent<{ chat: ChatSession }>) {
    selectedChat = event.detail.chat
    currentChat.set(event.detail.chat)
    if (currentView !== 'chat') {
      navigateTo('chat')
    }
    mobileView = 'main'
    // Tell service worker this chat is now open (suppresses notifications)
    postToServiceWorker({ type: 'CHAT_OPENED', chatId: event.detail.chat.id })
    // Clear any existing notification for this chat
    postToServiceWorker({ type: 'CLEAR_NOTIFICATION', chatId: event.detail.chat.id })
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
    selectedGroupId = null
    // Tell service worker no chat is open
    postToServiceWorker({ type: 'CHAT_OPENED', chatId: null })
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

  function handleProfileBack() {
    history.back()
  }

  function handleOpenChatFromProfile(pubkey: string) {
    // Check if we have an existing chat with this user
    const chatMap = get(chats)
    const existingChat = chatMap.get(pubkey)
    if (existingChat) {
      selectedChat = existingChat
      currentChat.set(existingChat)
    } else {
      // No existing chat - just go back to chat view
      // The user would need to receive an invite from this person to chat
      selectedChat = null
      currentChat.set(null)
    }
    navigateTo('chat')
    mobileView = 'main'
  }

  async function handleLogout() {
    stopMessageExpirationCleanup()
    logout()
    leaveChat()
    await clearChatData()
    resetManagers()
    loggedIn = false
    selectedChat = null
    selectedGroupId = null
    navigateTo('chat', false)
    mobileView = 'sidebar'
  }
</script>

<main class="min-h-[100dvh] h-[100dvh] bg-[#121212] text-white overflow-hidden">
  {#if initializing}
    <div class="h-full flex items-center justify-center">
      <div class="text-center">
        <div class="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
        <p class="text-gray-400">Loading...</p>
      </div>
    </div>
  {:else if duplicateTab}
    <div class="h-full flex flex-col items-center justify-center p-4">
      <div class="text-center flex flex-col items-center select-none">
        <img src="/iris-logo.png" alt="Iris" class="w-16 h-16 mb-4 opacity-50" draggable="false" />
        <h1 class="text-2xl font-bold text-gray-400 mb-4">Already open in another tab</h1>
        <p class="text-gray-500 max-w-sm">
          iris chat can only run in one tab at a time to keep your encrypted messages in sync.
        </p>
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
          md:w-80 lg:w-96 flex-shrink-0 h-full
          {mobileView === 'sidebar' ? 'block w-full' : 'hidden'} md:block
        ">
          <Sidebar
            selectedChatId={selectedChat?.id || null}
            {selectedGroupId}
            onSelectChat={handleSelectChat}
            onSelectGroup={handleSelectGroup}
            onNewChat={handleNewChat}
            onSettings={handleSettings}
          />
        </div>

        <!-- Main content - always visible on desktop, conditionally on mobile -->
        <div class="
          flex-1 flex flex-col bg-[#0a0a0a] h-full min-h-0 min-w-0
          {mobileView === 'main' ? 'flex w-full' : 'hidden'} md:flex md:w-auto
        ">
          {#if currentView === 'settings'}
            <SettingsView onBack={handleSettingsBack} onLogout={handleLogout} />
          {:else if currentView === 'profile' && profilePubkey}
            <ProfileView
              pubkey={profilePubkey}
              onBack={handleProfileBack}
              onOpenChat={handleOpenChatFromProfile}
            />
          {:else if currentView === 'createGroup'}
            <CreateGroup
              onBack={handleBack}
              onGroupCreated={handleGroupCreated}
            />
          {:else if currentView === 'groupDetails' && selectedGroupId && $groups.get(selectedGroupId)}
            <GroupDetailsView
              group={$groups.get(selectedGroupId)!}
              onBack={handleGroupDetailsBack}
              onDeleted={handleGroupDeleted}
              onViewProfile={navigateToProfile}
            />
          {:else if selectedGroupId && $groups.get(selectedGroupId)}
            <GroupChatView
              group={$groups.get(selectedGroupId)!}
              onleave={handleBack}
              showBackButton={mobileView === 'main'}
              onViewDetails={handleGroupDetails}
            />
          {:else}
            <MainContent
              chat={selectedChat}
              onChatJoined={handleChatJoined}
              onBack={handleBack}
              showBackButton={mobileView === 'main'}
              onViewProfile={navigateToProfile}
              onCreateGroup={handleNewGroup}
            />
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- PWA Install Prompt -->
  <InstallPrompt />
</main>
