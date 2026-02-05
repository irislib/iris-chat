<script lang="ts">
  import { notificationSettings } from '../lib/notificationStore'
  import { subscribeToDMNotifications, unsubscribeFromDMNotifications, NotificationService, type NotificationSubscription } from '../lib/notifications'
  import { identity, getPrivkeyHex } from '../lib/identity'
  import { nip19 } from 'nostr-tools'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  import CopyButton from './CopyButton.svelte'
  import QRScanner from './QRScanner.svelte'
  import { relayStore, DEFAULT_RELAYS, type RelayStatus } from '../lib/relayStore'
  import { receiptSettings, setSendDeliveryReceipts, setSendReadReceipts } from '../lib/receiptSettings'
  import { typingSettings, setSendTypingIndicators } from '../lib/typingSettings'
  import { devices } from '../lib/devices'
  import { parseLinkInviteInput } from '../lib/linkInvites'
  import { acceptLinkInvite, registerDevice, registerLinkedDevice, revokeDevice } from '../lib/privateChats'
  import { getErrorMessage } from '../lib/utils'

  interface Props {
    onBack: () => void
    onLogout: () => void
  }

  let { onBack, onLogout }: Props = $props()

  function handleLogout() {
    if (confirm('Are you sure you want to logout?\n\nAll chats will be permanently deleted.')) {
      onLogout()
    }
  }

  // Reactive state from store
  let settings = $state($notificationSettings)

  // Subscribe to store changes
  $effect(() => {
    const unsubscribe = notificationSettings.subscribe((value) => {
      settings = value
    })
    return unsubscribe
  })

  // Status indicators
  let notificationApiAvailable = $state(false)
  let permissionState = $state<NotificationPermission>('default')
  let serviceWorkerRunning = $state(false)
  let isSubscribed = $state(false)
  let showAdvanced = $state(false)
  let serverUrlInput = $state($notificationSettings.serverUrl)
  let isLoading = $state(false)
  let statusMessage = $state<{ type: 'success' | 'error'; text: string } | null>(null)
  let subscriptions = $state<Record<string, NotificationSubscription>>({})
  let loadingSubscriptions = $state(false)
  let showPrivateKey = $state(false)
  let registeringDevice = $state(false)
  let deviceError = $state('')
  let linkInviteModalOpen = $state(false)
  let linkInviteInput = $state('')
  let linkInviteStatus = $state<'idle' | 'accepting' | 'linked' | 'error'>('idle')
  let linkInviteError = $state('')
  let linkInviteShowScanner = $state(false)
  let linkInviteLastAutoAttempt = $state('')

  // Device state
  let deviceState = $state($devices)
  $effect(() => {
    const unsubscribe = devices.subscribe((value) => {
      deviceState = value
    })
    return unsubscribe
  })

  // Relay settings
  let editingRelays = $state(false)
  let newRelayUrl = $state('')
  let relays = $derived([...$relayStore.relays])
  let relayStatuses = $derived($relayStore.statuses)
  let showConnectivity = $derived($relayStore.showConnectivity)

  function getRelayStatus(url: string): RelayStatus {
    return relayStatuses.get(url) || 'disconnected'
  }

  function getStatusColor(status: RelayStatus): string {
    switch (status) {
      case 'connected': return 'bg-green-500'
      case 'connecting': return 'bg-yellow-500'
      default: return 'bg-gray-500'
    }
  }

  function addRelay() {
    const url = newRelayUrl.trim()
    if (!url) return
    try {
      new URL(url)
      if (!url.startsWith('wss://') && !url.startsWith('ws://')) return
    } catch { return }
    relayStore.addRelay(url)
    newRelayUrl = ''
  }

  function removeRelay(url: string) {
    relayStore.removeRelay(url)
  }

  function resetRelays() {
    relayStore.resetToDefaults()
    editingRelays = false
  }

  async function handleRegisterDevice() {
    if (registeringDevice) return
    registeringDevice = true
    deviceError = ''
    try {
      await registerDevice()
    } catch (e) {
      deviceError = getErrorMessage(e, 'Failed to register device')
    } finally {
      registeringDevice = false
    }
  }

  async function handleRevokeDevice(identityPubkey: string) {
    if (registeringDevice) return
    registeringDevice = true
    deviceError = ''
    try {
      await revokeDevice(identityPubkey)
    } catch (e) {
      deviceError = getErrorMessage(e, 'Failed to revoke device')
    } finally {
      registeringDevice = false
    }
  }

  function resetLinkInviteState() {
    linkInviteInput = ''
    linkInviteShowScanner = false
    linkInviteStatus = 'idle'
    linkInviteError = ''
    linkInviteLastAutoAttempt = ''
  }

  function closeLinkInviteModal() {
    linkInviteModalOpen = false
    resetLinkInviteState()
  }

  function handleOpenLinkInvite() {
    if (!$identity?.pubkey) return
    resetLinkInviteState()
    linkInviteModalOpen = true
  }

  async function handleAcceptLinkInvite(raw: string) {
    if (!$identity?.pubkey) return
    const invite = parseLinkInviteInput(raw, $identity.pubkey)
    if (!invite) {
      linkInviteError = 'Invalid link invite'
      linkInviteStatus = 'error'
      return
    }

    linkInviteStatus = 'accepting'
    linkInviteError = ''

    try {
      await acceptLinkInvite(invite)

      const identityPubkey = invite.inviter
      const alreadyRegistered = deviceState.registeredDevices.some(
        (d) => d.identityPubkey === identityPubkey
      )
      if (!alreadyRegistered) {
        await registerLinkedDevice(identityPubkey)
      }
      linkInviteStatus = 'linked'
    } catch (e) {
      linkInviteStatus = 'error'
      linkInviteError = getErrorMessage(e, 'Failed to link device')
    }
  }

  function handleLinkInviteScan(data: string) {
    linkInviteShowScanner = false
    linkInviteInput = data
    void handleAcceptLinkInvite(data)
  }

  $effect(() => {
    if (!linkInviteModalOpen) return
    if (!$identity?.pubkey) return
    if (!linkInviteInput) return
    if (linkInviteStatus !== 'idle') return
    if (linkInviteInput === linkInviteLastAutoAttempt) return

    const invite = parseLinkInviteInput(linkInviteInput, $identity.pubkey)
    if (!invite) return

    linkInviteLastAutoAttempt = linkInviteInput
    void handleAcceptLinkInvite(linkInviteInput)
  })

  // Get npub for public key
  const npub = $derived($identity?.pubkey ? nip19.npubEncode($identity.pubkey) : null)
  const isLinkedDevice = $derived($identity?.isLinkedDevice ?? false)

  // Get nsec for secret key
  const nsec = $derived.by(() => {
    const hex = getPrivkeyHex()
    if (!hex) return null
    const bytes = new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)))
    return nip19.nsecEncode(bytes)
  })

  // Check status on mount
  $effect(() => {
    checkStatus()
  })

  // Load subscriptions when advanced section is opened
  $effect(() => {
    if (showAdvanced && Object.keys(subscriptions).length === 0) {
      loadSubscriptions()
    }
  })

  async function checkStatus() {
    // Check Notification API
    notificationApiAvailable = 'Notification' in window

    // Check permission
    if (notificationApiAvailable) {
      permissionState = Notification.permission
    }

    // Check service worker
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration()
      serviceWorkerRunning = !!registration?.active

      // Check push subscription
      if (registration) {
        const subscription = await registration.pushManager?.getSubscription()
        isSubscribed = !!subscription
      }
    }
  }

  async function handleToggleNotifications() {
    isLoading = true
    statusMessage = null

    try {
      if (!settings.enabled) {
        // Enable notifications
        const result = await subscribeToDMNotifications()
        if (result.success) {
          statusMessage = { type: 'success', text: 'Notifications enabled' }
        } else {
          statusMessage = { type: 'error', text: result.error || 'Failed to enable notifications' }
        }
      } else {
        // Disable notifications
        const result = await unsubscribeFromDMNotifications()
        if (result.success) {
          statusMessage = { type: 'success', text: 'Notifications disabled' }
        } else {
          statusMessage = { type: 'error', text: result.error || 'Failed to disable notifications' }
        }
      }
    } catch (error) {
      statusMessage = { type: 'error', text: String(error) }
    }

    isLoading = false
    await checkStatus()
  }

  async function handleRequestPermission() {
    const result = await Notification.requestPermission()
    permissionState = result
  }

  async function handleSubscribe() {
    isLoading = true
    statusMessage = null

    try {
      const result = await subscribeToDMNotifications()
      if (result.success) {
        statusMessage = { type: 'success', text: 'Subscribed to notifications' }
      } else {
        statusMessage = { type: 'error', text: result.error || 'Failed to subscribe' }
      }
    } catch (error) {
      statusMessage = { type: 'error', text: String(error) }
    }

    isLoading = false
    await checkStatus()
  }

  async function handleSendTestNotification() {
    isLoading = true
    statusMessage = null

    try {
      if (permissionState === 'granted') {
        const registration = await navigator.serviceWorker.getRegistration()
        if (registration) {
          await registration.showNotification('Test Notification', {
            body: 'This is a test notification from iris chat',
            icon: '/iris-logo.png'
          })
        } else {
          new Notification('Test Notification', {
            body: 'This is a test notification from iris chat',
            icon: '/iris-logo.png'
          })
        }
        statusMessage = { type: 'success', text: 'Test notification sent' }
      } else {
        statusMessage = { type: 'error', text: 'Permission not granted' }
      }
    } catch (error) {
      statusMessage = { type: 'error', text: String(error) }
    }

    isLoading = false
  }

  function handleSaveServerUrl() {
    notificationSettings.setServerUrl(serverUrlInput)
    statusMessage = { type: 'success', text: 'Server URL saved' }
    // Reload subscriptions with new server URL
    loadSubscriptions()
  }

  async function loadSubscriptions() {
    loadingSubscriptions = true
    try {
      const api = new NotificationService()
      subscriptions = await api.getNotificationSubscriptions()
    } catch (error) {
      console.error('Failed to load subscriptions:', error)
      subscriptions = {}
    }
    loadingSubscriptions = false
  }

  async function handleDeleteSubscription(id: string) {
    try {
      const api = new NotificationService()
      await api.deleteNotificationSubscription(id)
      // Remove from local state
      const { [id]: _, ...rest } = subscriptions
      subscriptions = rest
      statusMessage = { type: 'success', text: 'Subscription deleted' }
    } catch (error) {
      statusMessage = { type: 'error', text: `Failed to delete: ${error}` }
    }
  }

  function formatKinds(kinds?: number[]): string {
    if (!kinds?.length) return ''
    const kindNames: Record<number, string> = { 1060: 'DM', 1059: 'Invite' }
    return kinds.map(k => kindNames[k] || `kind:${k}`).join(', ')
  }

  function truncatePubkey(pubkey: string): string {
    return pubkey.slice(0, 8) + '...' + pubkey.slice(-4)
  }

  function truncateEndpoint(endpoint: string): string {
    try {
      const url = new URL(endpoint)
      return url.hostname + '/...' + endpoint.slice(-8)
    } catch {
      return endpoint.slice(0, 20) + '...'
    }
  }
</script>

<div class="h-full flex flex-col bg-[#0a0a0a]">
  <!-- Header -->
  <header class="h-16 px-4 flex items-center gap-3 border-b border-surface-lighter flex-shrink-0 bg-surface">
    <button
      class="btn-ghost p-2"
      onclick={onBack}
      aria-label="Back"
    >
      <span class="i-carbon-arrow-left text-xl"></span>
    </button>
    <h1 class="text-xl font-semibold">Settings</h1>
  </header>

  <!-- Content -->
  <div class="flex-1 overflow-y-auto overscroll-contain p-4">
    <div class="max-w-lg mx-auto space-y-6">
      <!-- Status Message -->
      {#if statusMessage}
        <div class="p-3 rounded-lg {statusMessage.type === 'success' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}">
          {statusMessage.text}
        </div>
      {/if}

      <!-- Profile Section -->
      {#if $identity}
        <div class="bg-surface rounded-lg p-4">
          <div class="flex items-center gap-4">
            <Avatar pubkey={$identity.pubkey} size={64} />
            <div class="flex-1 min-w-0">
              <h2 class="font-medium text-lg truncate">
                <Name pubkey={$identity.pubkey} />
              </h2>
              <p class="text-sm text-gray-400">
                {$identity.isNip07 ? 'Logged in with extension' : 'Logged in with secret key'}
              </p>
            </div>
          </div>

          <!-- Public Key Section -->
          <div class="mt-4 pt-4 border-t border-surface-lighter">
            <span class="text-sm text-gray-400 block mb-2">Public Key</span>
            {#if npub}
              <CopyButton text={npub} maxLength={24} />
            {/if}
          </div>

          <!-- Secret Key Section (only for non-NIP07) -->
          {#if !$identity.isNip07 && nsec}
            <div class="mt-4 pt-4 border-t border-surface-lighter">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm text-gray-400">Secret Key</span>
                <button
                  class="text-xs text-primary hover:underline"
                  onclick={() => showPrivateKey = !showPrivateKey}
                >
                  {showPrivateKey ? 'Hide' : 'Show'}
                </button>
              </div>
              {#if showPrivateKey}
                <div class="bg-surface-light rounded p-2 mb-2">
                  <code class="text-xs text-gray-300 break-all">{nsec}</code>
                </div>
              {/if}
              <CopyButton text={nsec} label="Copy Secret Key" />
              <p class="text-xs text-red-400 mt-2">
                Never share your secret key. Anyone with it can access your account.
              </p>
            </div>
          {/if}

          <!-- Logout Button -->
          <div class="mt-4 pt-4 border-t border-surface-lighter">
            <button
              class="w-full flex items-center justify-center gap-2 text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded-lg py-2 transition-colors"
              onclick={handleLogout}
            >
              <span class="i-carbon-logout"></span>
              Logout
            </button>
          </div>
        </div>
      {/if}

      <!-- Devices Section -->
      {#if $identity}
        <div class="bg-surface rounded-lg p-4">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="font-medium">Devices</h2>
              <p class="text-sm text-gray-400 mt-1">Manage devices authorized for multi-device sync</p>
            </div>
          </div>

          {#if deviceError}
            <div class="p-2 mb-3 rounded text-sm bg-red-900/30 text-red-400">{deviceError}</div>
          {/if}

          {#if isLinkedDevice}
            <p class="text-xs text-gray-400">
              This is a linked device. Manage devices on your main client.
            </p>
          {:else if !deviceState.isCurrentDeviceRegistered}
            <button
              class="btn-primary w-full flex items-center justify-center gap-2"
              onclick={handleRegisterDevice}
              disabled={registeringDevice}
            >
              {registeringDevice ? 'Registering...' : 'Register this device'}
            </button>
            <p class="text-xs text-gray-500 mt-2">
              Registering enables multi-device message sync.
            </p>
          {:else}
            <div class="space-y-2">
              {#each deviceState.registeredDevices as device}
                <div class="flex items-center justify-between gap-2 p-2 bg-surface-light rounded">
                  <span class="text-xs font-mono text-gray-300">{truncatePubkey(device.identityPubkey)}</span>
                  {#if device.identityPubkey === deviceState.identityPubkey}
                    <span class="text-xs text-primary">This device</span>
                  {:else}
                    <button
                      class="text-xs text-red-400 hover:text-red-300"
                      onclick={() => handleRevokeDevice(device.identityPubkey)}
                      disabled={registeringDevice}
                    >
                      Revoke
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if !isLinkedDevice}
            <div class="mt-4 pt-4 border-t border-surface-lighter">
              <button
                class="btn-secondary w-full flex items-center justify-center gap-2"
                onclick={handleOpenLinkInvite}
              >
                <span class="i-carbon-qr-code"></span>
                Link another device
              </button>
              <p class="text-xs text-gray-500 mt-2">
                Paste or scan the link from your new device.
              </p>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Link Device Modal -->
      {#if linkInviteModalOpen}
        <div
          class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <button
            class="absolute inset-0 cursor-default border-none bg-transparent"
            onclick={closeLinkInviteModal}
            aria-label="Close modal"
          ></button>

          <div class="bg-surface rounded-2xl p-8 max-w-lg w-full relative z-10">
            <div class="flex justify-between items-center mb-6">
              <h3 class="text-xl font-semibold text-white">Link another device</h3>
              <button
                class="btn-ghost p-2"
                onclick={closeLinkInviteModal}
                aria-label="Close"
              >
                <span class="i-carbon-close text-xl"></span>
              </button>
            </div>

            <p class="text-gray-400 text-center mb-4">
              Paste or scan the link shown on your new device.
            </p>

            {#if linkInviteShowScanner}
              <div class="aspect-square rounded-lg overflow-hidden mb-4">
                <QRScanner onresult={handleLinkInviteScan} />
              </div>
              <button
                class="btn-secondary w-full flex items-center justify-center gap-2"
                onclick={() => linkInviteShowScanner = false}
              >
                <span class="i-carbon-text-link"></span>
                Paste Link Instead
              </button>
            {:else}
              <input
                type="text"
                bind:value={linkInviteInput}
                placeholder="Paste link invite"
                class="input-field"
                oninput={() => {
                  if (linkInviteStatus === 'error') {
                    linkInviteStatus = 'idle'
                    linkInviteError = ''
                  }
                }}
                disabled={linkInviteStatus === 'accepting'}
              />
              {#if linkInviteStatus === 'accepting'}
                <p class="text-sm text-gray-400 mt-3 text-center">Linking...</p>
              {/if}
              <button
                class="btn-secondary w-full flex items-center justify-center gap-2 mt-4"
                onclick={() => linkInviteShowScanner = true}
              >
                <span class="i-carbon-qr-code"></span>
                Scan QR Code
              </button>
            {/if}

            {#if linkInviteStatus === 'linked'}
              <p class="text-sm text-green-400 mt-4 text-center">Device linked</p>
            {:else if linkInviteStatus === 'error'}
              <p class="text-sm text-red-400 mt-4 text-center">{linkInviteError}</p>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Relays Section -->
      <div class="bg-surface rounded-lg p-4">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h2 class="font-medium">Relays</h2>
            <p class="text-sm text-gray-400 mt-1">Nostr servers for message delivery</p>
          </div>
          <button
            class="text-sm text-primary hover:underline"
            onclick={() => editingRelays = !editingRelays}
          >
            {editingRelays ? 'Done' : 'Edit'}
          </button>
        </div>

        <div class="space-y-2">
          {#each relays as relay (relay)}
            {@const status = getRelayStatus(relay)}
            <div class="flex items-center gap-2 p-2 bg-surface-light rounded">
              <span class="w-2 h-2 rounded-full {getStatusColor(status)} flex-shrink-0"></span>
              <span class="flex-1 text-sm truncate">
                {(() => { try { return new URL(relay).hostname } catch { return relay } })()}
              </span>
              {#if editingRelays}
                <button
                  class="text-red-400 hover:text-red-300 p-1"
                  onclick={() => removeRelay(relay)}
                  aria-label="Remove relay"
                >
                  <span class="i-carbon-close text-sm"></span>
                </button>
              {:else}
                <span class="text-xs text-gray-500 capitalize">{status}</span>
              {/if}
            </div>
          {/each}
        </div>

        {#if editingRelays}
          <div class="mt-3 flex gap-2">
            <input
              type="text"
              bind:value={newRelayUrl}
              placeholder="wss://relay.example.com"
              class="flex-1 input-field text-sm py-2"
              onkeydown={(e) => e.key === 'Enter' && addRelay()}
            />
            <button class="btn-primary text-sm px-3" onclick={addRelay}>Add</button>
          </div>
          <button
            class="mt-2 text-xs text-gray-500 hover:text-gray-400"
            onclick={resetRelays}
          >
            Reset to defaults
          </button>
        {/if}

        <!-- Show connectivity indicator toggle -->
        <div class="mt-4 pt-4 border-t border-surface-lighter flex items-center justify-between">
          <span class="text-sm">Show connectivity indicator</span>
          <button
            class="w-10 h-5 rounded-full transition-colors relative {showConnectivity ? 'bg-primary' : 'bg-gray-600'}"
            onclick={() => relayStore.setShowConnectivity(!showConnectivity)}
            role="switch"
            aria-checked={showConnectivity}
            aria-label="Toggle connectivity indicator"
          >
            <span
              class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform {showConnectivity ? 'translate-x-5' : ''}"
            ></span>
          </button>
        </div>
      </div>

      <!-- Privacy Section -->
      <div class="bg-surface rounded-lg p-4">
        <h2 class="font-medium mb-3">Privacy</h2>
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <div>
              <span class="text-sm">Send delivery receipts</span>
              <p class="text-xs text-gray-500 mt-0.5">Let others know their message was delivered</p>
            </div>
            <button
              class="w-10 h-5 rounded-full transition-colors relative {$receiptSettings.sendDeliveryReceipts ? 'bg-primary' : 'bg-gray-600'}"
              onclick={() => setSendDeliveryReceipts(!$receiptSettings.sendDeliveryReceipts)}
              role="switch"
              aria-checked={$receiptSettings.sendDeliveryReceipts}
              aria-label="Toggle delivery receipts"
            >
              <span
                class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform {$receiptSettings.sendDeliveryReceipts ? 'translate-x-5' : ''}"
              ></span>
            </button>
          </div>
          <div class="flex items-center justify-between">
            <div>
              <span class="text-sm">Send read receipts</span>
              <p class="text-xs text-gray-500 mt-0.5">Let others know when you've read their messages</p>
            </div>
            <button
              class="w-10 h-5 rounded-full transition-colors relative {$receiptSettings.sendReadReceipts ? 'bg-primary' : 'bg-gray-600'}"
              onclick={() => setSendReadReceipts(!$receiptSettings.sendReadReceipts)}
              role="switch"
              aria-checked={$receiptSettings.sendReadReceipts}
              aria-label="Toggle read receipts"
            >
              <span
                class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform {$receiptSettings.sendReadReceipts ? 'translate-x-5' : ''}"
              ></span>
            </button>
          </div>
          <div class="flex items-center justify-between">
            <div>
              <span class="text-sm">Send typing indicators</span>
              <p class="text-xs text-gray-500 mt-0.5">Let others know when you're typing</p>
            </div>
            <button
              class="w-10 h-5 rounded-full transition-colors relative {$typingSettings.sendTypingIndicators ? 'bg-primary' : 'bg-gray-600'}"
              onclick={() => setSendTypingIndicators(!$typingSettings.sendTypingIndicators)}
              role="switch"
              aria-checked={$typingSettings.sendTypingIndicators}
              aria-label="Toggle typing indicators"
            >
              <span
                class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform {$typingSettings.sendTypingIndicators ? 'translate-x-5' : ''}"
              ></span>
            </button>
          </div>
        </div>
      </div>

      <!-- Notifications Section -->
      <div class="bg-surface rounded-lg p-4">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="font-medium">Notifications</h2>
            <p class="text-sm text-gray-400 mt-1">Get notified when you receive new messages</p>
          </div>
          <button
            class="w-12 h-6 rounded-full transition-colors relative {settings.enabled ? 'bg-primary' : 'bg-gray-600'} {isLoading ? 'opacity-50' : ''}"
            onclick={handleToggleNotifications}
            disabled={isLoading}
            role="switch"
            aria-checked={settings.enabled}
            aria-label="Toggle DM notifications"
          >
            <span
              class="absolute top-1 w-4 h-4 bg-white rounded-full transition-transform {settings.enabled ? 'left-7' : 'left-1'}"
            ></span>
          </button>
        </div>

        <!-- Status -->
        <div class="mt-4 pt-4 border-t border-surface-lighter space-y-3">
          <div class="flex items-center justify-between text-sm">
            <span class="text-gray-400">Notification API</span>
            <span class="flex items-center gap-2">
              {#if notificationApiAvailable}
                <span class="i-carbon-checkmark-filled text-green-500"></span>
                <span class="text-green-500">Available</span>
              {:else}
                <span class="i-carbon-close-filled text-red-500"></span>
                <span class="text-red-500">Not Available</span>
              {/if}
            </span>
          </div>

          <div class="flex items-center justify-between text-sm">
            <span class="text-gray-400">Permission</span>
            <span class="flex items-center gap-2">
              {#if permissionState === 'granted'}
                <span class="i-carbon-checkmark-filled text-green-500"></span>
                <span class="text-green-500">Granted</span>
              {:else if permissionState === 'denied'}
                <span class="i-carbon-close-filled text-red-500"></span>
                <span class="text-red-500">Denied</span>
              {:else}
                <span class="i-carbon-warning-filled text-yellow-500"></span>
                <span class="text-yellow-500">Not Requested</span>
                <button class="btn-primary text-xs py-1 px-2" onclick={handleRequestPermission}>
                  Allow
                </button>
              {/if}
            </span>
          </div>

          <div class="flex items-center justify-between text-sm">
            <span class="text-gray-400">Service Worker</span>
            <span class="flex items-center gap-2">
              {#if serviceWorkerRunning}
                <span class="i-carbon-checkmark-filled text-green-500"></span>
                <span class="text-green-500">Running</span>
              {:else}
                <span class="i-carbon-close-filled text-red-500"></span>
                <span class="text-red-500">Not Running</span>
              {/if}
            </span>
          </div>

          <div class="flex items-center justify-between text-sm">
            <span class="text-gray-400">Push Subscription</span>
            <span class="flex items-center gap-2">
              {#if isSubscribed}
                <span class="i-carbon-checkmark-filled text-green-500"></span>
                <span class="text-green-500">Subscribed</span>
              {:else}
                <span class="i-carbon-close-filled text-red-500"></span>
                <span class="text-red-500">Not Subscribed</span>
                {#if serviceWorkerRunning && permissionState === 'granted'}
                  <button
                    class="btn-primary text-xs py-1 px-2"
                    onclick={handleSubscribe}
                    disabled={isLoading}
                  >
                    Subscribe
                  </button>
                {/if}
              {/if}
            </span>
          </div>
        </div>

        <!-- Test Notification -->
        <div class="mt-4 pt-4 border-t border-surface-lighter">
          <button
            class="btn-secondary w-full flex items-center justify-center"
            onclick={handleSendTestNotification}
            disabled={permissionState !== 'granted' || isLoading}
          >
            <span class="i-carbon-notification mr-2"></span>
            Send Test Notification
          </button>
        </div>
      </div>

      <!-- Source Code & Releases -->
      <div class="bg-surface rounded-lg p-4 space-y-3">
        <a
          href="https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/iris-chat"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2 text-primary hover:underline"
        >
          <span class="i-carbon-code text-lg"></span>
          View Source Code
        </a>
        <a
          href="https://github.com/irislib/iris-chat/releases"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2 text-primary hover:underline"
        >
          <span class="i-carbon-download text-lg"></span>
          Download Latest Release
        </a>
      </div>

      <!-- Advanced Section -->
      <div class="bg-surface rounded-lg p-4">
        <button
          class="w-full flex items-center justify-between text-left"
          onclick={() => showAdvanced = !showAdvanced}
        >
          <h2 class="font-medium">Advanced</h2>
          <span class="i-carbon-chevron-down text-gray-400 transition-transform {showAdvanced ? 'rotate-180' : ''}"></span>
        </button>

        {#if showAdvanced}
          <div class="mt-4 space-y-4">
            <div>
              <label class="block text-sm text-gray-400 mb-2" for="server-url">
                Notification Server URL
              </label>
              <div class="flex gap-2">
                <input
                  id="server-url"
                  type="url"
                  class="flex-1 bg-surface-light border border-surface-lighter rounded px-3 py-2 text-sm"
                  bind:value={serverUrlInput}
                  placeholder="https://notifications.iris.to"
                />
                <button class="btn-primary px-3" onclick={handleSaveServerUrl}>
                  Save
                </button>
              </div>
            </div>

            <!-- Active Subscriptions -->
            <div>
              <div class="flex items-center justify-between mb-2">
                <span class="block text-sm text-gray-400">Active Subscriptions</span>
                <button
                  class="text-xs text-primary hover:underline"
                  onclick={loadSubscriptions}
                  disabled={loadingSubscriptions}
                >
                  {loadingSubscriptions ? 'Loading...' : 'Refresh'}
                </button>
              </div>
              {#if loadingSubscriptions}
                <div class="text-sm text-gray-500 py-2">Loading...</div>
              {:else if Object.keys(subscriptions).length === 0}
                <div class="text-sm text-gray-500 py-2">No active subscriptions</div>
              {:else}
                <div class="space-y-3">
                  {#each Object.entries(subscriptions) as [id, sub]}
                    <div class="bg-surface-light rounded p-3 text-sm">
                      <div class="flex items-start justify-between gap-2 mb-2">
                        <div class="text-gray-300 font-mono text-xs" title={id}>
                          ID: {id.slice(0, 12)}...
                        </div>
                        <button
                          class="text-red-400 hover:text-red-300 flex-shrink-0"
                          onclick={() => handleDeleteSubscription(id)}
                          title="Delete subscription"
                        >
                          <span class="i-carbon-trash-can"></span>
                        </button>
                      </div>

                      {#if sub.filter.kinds?.length}
                        <div class="text-gray-400 text-xs mb-1">
                          <span class="text-gray-500">Kinds:</span> {formatKinds(sub.filter.kinds)}
                        </div>
                      {/if}

                      {#if sub.filter.authors?.length}
                        <div class="text-xs mb-1">
                          <span class="text-gray-500">Authors ({sub.filter.authors.length}):</span>
                          <div class="text-gray-400 font-mono mt-1 space-y-0.5">
                            {#each sub.filter.authors.slice(0, 5) as author}
                              <div title={author}>{truncatePubkey(author)}</div>
                            {/each}
                            {#if sub.filter.authors.length > 5}
                              <div class="text-gray-500">...and {sub.filter.authors.length - 5} more</div>
                            {/if}
                          </div>
                        </div>
                      {/if}

                      {#if sub.web_push_subscriptions?.length}
                        <div class="text-xs">
                          <span class="text-gray-500">Endpoints ({sub.web_push_subscriptions.length}):</span>
                          <div class="text-gray-400 font-mono mt-1 space-y-0.5">
                            {#each sub.web_push_subscriptions as pushSub}
                              <div title={pushSub.endpoint}>{truncateEndpoint(pushSub.endpoint)}</div>
                            {/each}
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      <!-- About Section -->
      <div class="bg-surface rounded-lg p-4">
        <h2 class="font-medium mb-3">About iris chat</h2>
        <div class="text-sm text-gray-400 space-y-3">
          <p>
            Encrypted chat powered by the
            <a href="https://en.wikipedia.org/wiki/Double_Ratchet_Algorithm" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">double ratchet algorithm</a>
            for end-to-end encryption.
          </p>
          <p>
            Your main key stays on this device. Multi-device sync uses per-device identities to relay messages safely.
          </p>
          <p class="text-gray-500">
            Multi-device is now supported. Register each device to enable syncing across them.
          </p>
          <div class="pt-3 border-t border-surface-lighter space-y-1 text-xs text-gray-500">
            <div class="flex justify-between">
              <span>Version</span>
              <span class="font-mono">{import.meta.env.VITE_APP_VERSION || 'dev'}</span>
            </div>
            <div class="flex justify-between">
              <span>Build</span>
              <span class="font-mono">{(() => { const t = import.meta.env.VITE_BUILD_TIME; if (!t || t === 'undefined') return 'development'; try { return new Date(t).toLocaleString() } catch { return t } })()}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
