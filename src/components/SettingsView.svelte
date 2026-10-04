<script lang="ts">
  import { tick, onDestroy } from 'svelte'
  import { SETTINGS_PAGES, settingsHref, type SettingsPage } from '../lib/settingsNavigation'
  import { notificationSettings } from '../lib/notificationStore'
  import { getNotificationSupportError, requestNotificationPermission } from '../lib/notificationPermission'
  import { subscribeToDMNotifications, unsubscribeFromDMNotifications, NotificationService, type NotificationSubscription } from '../lib/notifications'
  import { identity, getPrivkeyHex, updateOwnProfile } from '../lib/identity'
  import { nip19 } from 'nostr-tools'
  import { minidenticon } from 'minidenticons'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  import CopyButton from './CopyButton.svelte'
  import MediaModal from './MediaModal.svelte'
  import QRScanner from './QRScanner.svelte'
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { resolvePictureUrl, formatHtreePicture } from '../lib/profilePicture'
  import { uploadFile } from '../lib/hashtree'
  import { relayStore, DEFAULT_RELAYS, type RelayStatus } from '../lib/relayStore'
  import { messageDeletionSettings, setAllowDeletionByOthers } from '../lib/messageDeletionSettings'
  import { receiptSettings, setSendDeliveryReceipts, setSendReadReceipts } from '../lib/receiptSettings'
  import { typingSettings, setSendTypingIndicators } from '../lib/typingSettings'
  import { callSettings, setCallSettings } from '../lib/callSettings'
  import CallQualityControls from './CallQualityControls.svelte'
  import { callConnectionSettings, setCallServers } from '../lib/callConnectionSettings'
  let callServers = $state('')
  let callServerError = $state('')
  $effect(() => { callServers = $callConnectionSettings.servers.join('\n') })
  import { messageRequestSettings, setReceiveMessageRequests } from '../lib/messageRequestSettings'
  import { devices } from '../lib/devices'
  import { describeDeviceRosterDevice, meaningfulDeviceName } from '../lib/deviceLabels'
  import { setThemePreference, themePreference, type ThemePreference } from '../lib/theme'
  import {
    acceptDeviceLink,
    ensureDeviceRegistered,
    getAppKeysManager,
    revokeDevice,
    revokeDevices,
  } from '../lib/privateChats'
  import { approveDeviceConnectLink, parseDeviceConnectLink } from '../lib/deviceLinkSigner'
  import { parseLinkInviteInput } from '../lib/linkInvites'
  import { parseCompactDeviceLinkRequest } from 'nostr-double-ratchet'
  import { getErrorMessage } from '../lib/utils'
  import { NATIVE_APP_DOWNLOAD_URL } from '../lib/nativeApp'

  interface Props {
    page: SettingsPage | null
    onNavigate: (page: SettingsPage) => void
    onBack: () => void
    onLogout: () => void
  }

  let { page, onNavigate, onBack, onLogout }: Props = $props()
  let detailPage = $derived(page ?? 'profile')
  let detailTitle = $derived(SETTINGS_PAGES.find((entry) => entry.id === detailPage)?.title ?? 'Profile')
  const menuGroups = [...new Set(SETTINGS_PAGES.map((entry) => entry.group))]
  let settingsContainer = $state<HTMLDivElement | null>(null)
  let detailPane = $state<HTMLElement | null>(null)
  let titleHeading = $state<HTMLHeadingElement | null>(null)

  function handleNavigate(event: MouseEvent, destination: SettingsPage) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onNavigate(destination)
  }

  function handleLogout() {
    if (confirm('Log out?\n\nYour profile and chats will be removed from this browser. Your other devices are not affected. Make sure you have your secret key or another linked device before continuing.')) {
      onLogout()
    }
  }

  let settings = $derived($notificationSettings)

  // Status indicators
  let notificationApiAvailable = $state(false)
  let notificationSupportError = $state<string | null>(null)
  let notificationStatus = $state<{ type: 'success' | 'error'; text: string } | null>(null)
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
  let linkApproval: AbortController | undefined
  onDestroy(() => linkApproval?.abort())
  function linkKind(raw: string): 'connect' | 'legacy' | null {
    try { parseDeviceConnectLink(raw); return 'connect' } catch { /* Other supported links follow. */ }
    return parseCompactDeviceLinkRequest(raw) || ($identity?.pubkey && parseLinkInviteInput(raw, $identity.pubkey)) ? 'legacy' : null
  }
  let linkInviteModalOpen = $state(false)
  let linkInviteInput = $state('')
  let linkInviteStatus = $state<'idle' | 'accepting' | 'linked' | 'error'>('idle')
  let linkInviteError = $state('')
  let linkInviteShowScanner = $state(false)
  let showPictureModal = $state(false)
  let proxiedFullPicture = $state<string | null>(null)
  let profileNameInput = $state('')
  let profileNameDirty = $state(false)
  let savingProfileName = $state(false)
  let uploadingProfilePicture = $state(false)
  let profileUploadProgress = $state(0)
  let profilePictureInputRef = $state<HTMLInputElement | null>(null)

  let profileStore = $derived($identity?.pubkey ? createProfileStore($identity.pubkey) : undefined)
  let profile = $derived(profileStore ? $profileStore ?? undefined : undefined)
  let profilePicture = $derived(profile?.picture)
  let profilePictureName = $derived(getProfileName(profile) || $identity?.displayName || 'Profile picture')
  let canEditProfile = $derived(!($identity?.isLinkedDevice ?? false))
  let canSaveProfileName = $derived.by(() => {
    if (!canEditProfile) return false
    const nextName = profileNameInput.trim()
    const currentName = (profile?.display_name || profile?.name || '').trim()
    return nextName.length > 0 && nextName !== currentName
  })
  let fallbackProfilePicture = $derived.by(() => {
    if (!$identity?.pubkey) return null
    const identicon = minidenticon($identity.pubkey, 90, 50)
    return `data:image/svg+xml;utf8,${encodeURIComponent(identicon)}`
  })
  let modalPicture = $derived((proxiedFullPicture || profilePicture || fallbackProfilePicture) ?? null)
  const appLogoUrl = `${import.meta.env.BASE_URL}iris-logo.png`

  // Device state
  let deviceState = $derived($devices)
  let selectedDevicePubkeys = $state<string[]>([])
  let revocableDevicePubkeys = $derived(
    deviceState.registeredDevices
      .map((device) => device.identityPubkey)
      .filter((pubkey) => pubkey !== deviceState.identityPubkey)
  )
  let selectedRevocableDevicePubkeys = $derived(
    selectedDevicePubkeys.filter((pubkey) => revocableDevicePubkeys.includes(pubkey))
  )
  let allRevocableDevicesSelected = $derived(
    revocableDevicePubkeys.length > 0 &&
      revocableDevicePubkeys.every((pubkey) => selectedRevocableDevicePubkeys.includes(pubkey))
  )
  // Relay settings
  let editingRelays = $state(false)
  let newRelayUrl = $state('')
  let relays = $derived([...$relayStore.relays])
  let relayStatuses = $derived($relayStore.statuses)
  let showConnectivity = $derived($relayStore.showConnectivity)

  $effect(() => {
    // A new destination must not retain a revealed key, scanner, or old feedback.
    const destination = page
    showPrivateKey = false
    showPictureModal = false
    statusMessage = null
    notificationStatus = null
    deviceError = ''
    callServerError = ''
    showAdvanced = false
    editingRelays = false
    selectedDevicePubkeys = []
    closeLinkInviteModal()
    void tick().then(() => {
      if (destination !== page) return
      detailPane?.scrollTo({ top: 0 })
      if (destination && settingsContainer && settingsContainer.clientWidth < 700) {
        titleHeading?.focus({ preventScroll: true })
      }
    })
  })

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
      // ensureDeviceRegistered starts invite publishing for reliable SessionManager
      // establishment when other users try to DM this device.
      await ensureDeviceRegistered()
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
      selectedDevicePubkeys = selectedDevicePubkeys.filter((pubkey) => pubkey !== identityPubkey)
    } catch (e) {
      deviceError = getErrorMessage(e, 'Failed to revoke device')
    } finally {
      registeringDevice = false
    }
  }

  function isDeviceSelected(identityPubkey: string): boolean {
    return selectedDevicePubkeys.includes(identityPubkey)
  }

  function setDeviceSelected(identityPubkey: string, selected: boolean) {
    if (identityPubkey === deviceState.identityPubkey) return

    if (selected) {
      selectedDevicePubkeys = Array.from(new Set([...selectedDevicePubkeys, identityPubkey]))
      return
    }

    selectedDevicePubkeys = selectedDevicePubkeys.filter((pubkey) => pubkey !== identityPubkey)
  }

  function setAllRevocableDevicesSelected(selected: boolean) {
    selectedDevicePubkeys = selected ? [...revocableDevicePubkeys] : []
  }

  async function handleRevokeSelectedDevices() {
    if (registeringDevice || selectedRevocableDevicePubkeys.length === 0) return

    const selectedCount = selectedRevocableDevicePubkeys.length
    const label = selectedCount === 1 ? '1 device' : `${selectedCount} devices`
    if (!confirm(`Revoke ${label}?`)) return

    registeringDevice = true
    deviceError = ''
    try {
      const revokedPubkeys = [...selectedRevocableDevicePubkeys]
      await revokeDevices(revokedPubkeys)
      selectedDevicePubkeys = selectedDevicePubkeys.filter(
        (pubkey) => !revokedPubkeys.includes(pubkey)
      )
    } catch (e) {
      deviceError = getErrorMessage(e, 'Failed to revoke selected devices')
    } finally {
      registeringDevice = false
    }
  }

  $effect(() => {
    const validPubkeys = new Set(revocableDevicePubkeys)
    const nextSelection = selectedDevicePubkeys.filter((pubkey) => validPubkeys.has(pubkey))
    if (nextSelection.length !== selectedDevicePubkeys.length) {
      selectedDevicePubkeys = nextSelection
    }
  })

  function resetLinkInviteState() {
    linkApproval?.abort()
    linkApproval = undefined
    linkInviteInput = ''
    linkInviteShowScanner = false
    linkInviteStatus = 'idle'
    linkInviteError = ''
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

  async function handleAcceptLinkInvite(raw: string, historyChoice: 'chats' | 'history') {
    if (!$identity?.pubkey) return
    const kind = linkKind(raw)
    if (!kind) {
      linkInviteError = 'Invalid link code'
      linkInviteStatus = 'error'
      return
    }

    linkInviteStatus = 'accepting'
    linkInviteError = ''

    try {
      linkApproval = new AbortController()
      if (kind === 'connect') await approveDeviceConnectLink(raw, historyChoice, linkApproval.signal)
      else await acceptDeviceLink(raw, historyChoice)
      linkInviteStatus = 'linked'
      closeLinkInviteModal()
    } catch (e) {
      linkInviteStatus = 'error'
      linkInviteError = getErrorMessage(e, 'Failed to link device')
    }
  }

  function handleLinkInviteScan(data: string) {
    linkInviteShowScanner = false
    linkInviteInput = data
  }

  $effect(() => {
    const pic = profilePicture
    if (!pic) {
      proxiedFullPicture = null
      return
    }

    let cancelled = false
    resolvePictureUrl(pic, { width: 800 })
      .then(url => {
        if (cancelled) return
        if (url !== proxiedFullPicture) proxiedFullPicture = url
      })
      .catch(() => {})

    return () => { cancelled = true }
  })

  $effect(() => {
    if (profileNameDirty) return
    profileNameInput = profile?.display_name || profile?.name || ''
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

  function handleThemeChange(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value as ThemePreference
    setThemePreference(value)
  }

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
    notificationSupportError = getNotificationSupportError()

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
    notificationStatus = null

    try {
      if (!settings.enabled) {
        // Enable notifications
        const result = await subscribeToDMNotifications()
        if (result.success) {
          notificationStatus = { type: 'success', text: 'Notifications enabled' }
        } else {
          notificationStatus = { type: 'error', text: result.error || 'Failed to enable notifications' }
        }
      } else {
        // Disable notifications
        const result = await unsubscribeFromDMNotifications()
        if (result.success) {
          notificationStatus = { type: 'success', text: 'Notifications disabled' }
        } else {
          notificationStatus = { type: 'error', text: result.error || 'Failed to disable notifications' }
        }
      }
    } catch (error) {
      notificationStatus = { type: 'error', text: String(error) }
    }

    isLoading = false
    await checkStatus()
  }

  async function handleRequestPermission() {
    isLoading = true
    notificationStatus = null
    const result = await requestNotificationPermission()
    permissionState = result.permission
    if (result.error) notificationStatus = { type: 'error', text: result.error }
    isLoading = false
  }

  async function handleSubscribe() {
    isLoading = true
    notificationStatus = null

    try {
      const result = await subscribeToDMNotifications()
      if (result.success) {
        notificationStatus = { type: 'success', text: 'Subscribed to notifications' }
      } else {
        notificationStatus = { type: 'error', text: result.error || 'Failed to subscribe' }
      }
    } catch (error) {
      notificationStatus = { type: 'error', text: String(error) }
    }

    isLoading = false
    await checkStatus()
  }

  async function handleSendTestNotification() {
    isLoading = true
    notificationStatus = null

    try {
      if (permissionState === 'granted') {
        const registration = await navigator.serviceWorker.getRegistration()
        if (registration) {
          await registration.showNotification('Test Notification', {
            body: 'This is a test notification from iris chat',
            icon: appLogoUrl
          })
        } else {
          new Notification('Test Notification', {
            body: 'This is a test notification from iris chat',
            icon: appLogoUrl
          })
        }
        notificationStatus = { type: 'success', text: 'Test notification sent' }
      } else {
        notificationStatus = { type: 'error', text: 'Permission not granted' }
      }
    } catch (error) {
      notificationStatus = { type: 'error', text: String(error) }
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

  function formatAddedAgo(createdAtSecs: number): string | null {
    if (!createdAtSecs) return null
    const elapsed = Math.abs(Date.now() / 1000 - createdAtSecs)
    if (elapsed < 60) return 'just now'
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`
    if (elapsed < 86_400) return `${Math.floor(elapsed / 3600)}h ago`
    if (elapsed < 86_400 * 30) return `${Math.floor(elapsed / 86_400)}d ago`
    if (elapsed < 86_400 * 365) return `${Math.floor(elapsed / (86_400 * 30))}mo ago`
    return `${Math.floor(elapsed / (86_400 * 365))}y ago`
  }

  function getDeviceDisplay(identityPubkey: string) {
    const isCurrentDevice = identityPubkey === deviceState.identityPubkey
    try {
      return describeDeviceRosterDevice(
        identityPubkey,
        getAppKeysManager().getDeviceLabels(identityPubkey),
        isCurrentDevice,
        deviceState.registeredDevices.filter(device => !meaningfulDeviceName(getAppKeysManager().getDeviceLabels(device.identityPubkey)?.deviceLabel)).map(device => device.identityPubkey)
      )
    } catch {
      return describeDeviceRosterDevice(identityPubkey, undefined, isCurrentDevice)
    }
  }

  function truncateEndpoint(endpoint: string): string {
    try {
      const url = new URL(endpoint)
      return url.hostname + '/...' + endpoint.slice(-8)
    } catch {
      return endpoint.slice(0, 20) + '...'
    }
  }

  function handleAvatarClick() {
    if (modalPicture) {
      showPictureModal = true
    }
  }

  function handleProfileNameInput() {
    profileNameDirty = true
  }

  async function handleSaveProfileName() {
    if (!canEditProfile) {
      statusMessage = { type: 'error', text: 'Edit your profile on your main device' }
      return
    }
    if (!canSaveProfileName || savingProfileName) return

    savingProfileName = true
    statusMessage = null

    try {
      const name = profileNameInput.trim()
      await updateOwnProfile({ name, baseProfile: profile })
      profileNameDirty = false
      statusMessage = { type: 'success', text: 'Profile name updated' }
    } catch (e) {
      statusMessage = { type: 'error', text: getErrorMessage(e, 'Failed to update profile') }
    } finally {
      savingProfileName = false
    }
  }

  async function handleProfilePictureSelect(e: Event) {
    if (!canEditProfile) {
      statusMessage = { type: 'error', text: 'Edit your profile on your main device' }
      return
    }
    if (uploadingProfilePicture) return

    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    input.value = ''

    uploadingProfilePicture = true
    profileUploadProgress = 0
    statusMessage = null

    try {
      const { nhash, filename } = await uploadFile(file, (bytesUploaded, totalBytes) => {
        if (totalBytes <= 0) return
        profileUploadProgress = Math.round((bytesUploaded / totalBytes) * 100)
      })
      const picture = formatHtreePicture(nhash, filename)
      await updateOwnProfile({ picture, baseProfile: profile })
      statusMessage = { type: 'success', text: 'Profile picture updated' }
    } catch (error) {
      statusMessage = {
        type: 'error',
        text: getErrorMessage(error, 'Failed to upload profile picture'),
      }
    } finally {
      uploadingProfilePicture = false
      profileUploadProgress = 0
    }
  }
</script>

<div bind:this={settingsContainer} class="settings-container h-full flex flex-col bg-panel" class:settings-has-page={page !== null}>
  <header class="h-16 px-4 flex items-center gap-3 border-b border-surface-lighter flex-shrink-0 bg-surface">
    <button class="btn-ghost p-2" onclick={onBack} aria-label="Back">
      <span class="i-carbon-arrow-left text-xl" aria-hidden="true"></span>
    </button>
    <h1 bind:this={titleHeading} tabindex="-1" class="text-xl font-semibold">
      <span class="settings-narrow-title">{page ? detailTitle : 'Settings'}</span>
      <span class="settings-wide-title">Settings</span>
    </h1>
  </header>

  <div class="settings-layout">
    <nav class="settings-menu" aria-label="Settings sections">
      {#each menuGroups as group}
        <div class="settings-menu-group">
          {#each SETTINGS_PAGES.filter((entry) => entry.group === group) as entry}
            <a
              href={settingsHref(entry.id)}
              aria-label={entry.title}
              aria-current={detailPage === entry.id ? 'page' : undefined}
              class="settings-menu-row"
              class:settings-profile-row={entry.id === 'profile'}
              onclick={(event) => handleNavigate(event, entry.id)}
            >
              {#if entry.id === 'profile' && $identity}
                <Avatar pubkey={$identity.pubkey} size={44} />
                <span class="min-w-0 flex-1">
                  <span class="block font-semibold truncate"><Name pubkey={$identity.pubkey} /></span>
                  <span class="block text-sm text-gray-400">Profile</span>
                </span>
              {:else}
                <span class={`${entry.icon} text-xl flex-shrink-0`} aria-hidden="true"></span>
                <span class="flex-1">{entry.title}</span>
              {/if}
              <span class="i-carbon-chevron-right text-sm text-gray-400" aria-hidden="true"></span>
            </a>
          {/each}
        </div>
      {/each}
      <button class="settings-menu-row settings-logout text-red-400" onclick={handleLogout}>
        <span class="i-carbon-logout text-xl" aria-hidden="true"></span>
        <span>Log out</span>
      </button>
    </nav>

    <section bind:this={detailPane} class="settings-detail" aria-label={detailTitle}>
      <div class="settings-detail-content space-y-5">
        <h2 class="settings-wide-title text-xl font-semibold">{detailTitle}</h2>
        {#if statusMessage}
          <div role={statusMessage.type === 'error' ? 'alert' : 'status'} class="p-3 rounded-lg {statusMessage.type === 'success' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}">
            {statusMessage.text}
          </div>
        {/if}
        {#if detailPage === 'profile'}
      <!-- Profile Section -->
      {#if $identity}
        <div class="bg-surface rounded-lg p-4">
          <input
            bind:this={profilePictureInputRef}
            type="file"
            class="hidden"
            accept="image/*"
            onchange={handleProfilePictureSelect}
          />

          <div class="flex items-center gap-4">
            <div class="relative">
              <button
                class="rounded-full overflow-hidden cursor-pointer hover:opacity-90 transition-opacity"
                onclick={handleAvatarClick}
                aria-label="View profile picture"
              >
                <Avatar pubkey={$identity.pubkey} size={64} />
              </button>
              <button
                class="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-surface-light border border-surface-lighter flex items-center justify-center text-gray-400 hover:text-white hover:bg-primary transition-colors"
                onclick={() => profilePictureInputRef?.click()}
                disabled={uploadingProfilePicture || !canEditProfile}
                aria-label="Change profile picture"
              >
                {#if uploadingProfilePicture}
                  <span class="text-[10px] font-medium">{profileUploadProgress}%</span>
                {:else}
                  <span class="i-carbon-camera text-sm"></span>
                {/if}
              </button>
            </div>
            <div class="flex-1 min-w-0">
              <h2 class="font-medium text-lg truncate">
                <Name pubkey={$identity.pubkey} />
              </h2>
              <p class="text-sm text-gray-400">
                {$identity.isNip07 ? 'Logged in with extension' : 'Logged in with secret key'}
              </p>
            </div>
          </div>

          <div class="mt-4 pt-4 border-t border-surface-lighter">
            <label for="profile-name" class="text-sm text-gray-400 block mb-2">Display name</label>
            <div class="flex items-center gap-2">
              <input
                id="profile-name"
                type="text"
                class="input-field flex-1 min-w-0"
                bind:value={profileNameInput}
                disabled={!canEditProfile || savingProfileName}
                oninput={handleProfileNameInput}
                onkeydown={(e) => e.key === 'Enter' && handleSaveProfileName()}
              />
              <button
                class="btn-primary px-4 py-2 whitespace-nowrap disabled:opacity-40"
                onclick={handleSaveProfileName}
                disabled={!canSaveProfileName || savingProfileName}
              >
                {savingProfileName ? 'Saving...' : 'Save'}
              </button>
            </div>
            {#if !canEditProfile}
              <p class="text-xs text-gray-500 mt-2">
                Edit your profile on your main device.
              </p>
            {/if}
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


        </div>
      {/if}
        {:else if detailPage === 'appearance'}
      <!-- Appearance Section -->
      <div class="bg-surface rounded-lg p-4">
        <label for="theme-preference" class="text-sm text-gray-400 block mb-2">Theme</label>
        <select
          id="theme-preference"
          class="input-field"
          value={$themePreference}
          onchange={handleThemeChange}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
        {:else if detailPage === 'privacy'}
      <!-- Privacy Section -->
      <div class="bg-surface rounded-lg p-4">
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between gap-4">
            <div class="flex-1 min-w-0">
              <span class="text-sm">Allow others to delete their messages</span>
              <p class="text-xs text-gray-500 mt-0.5">Let people delete messages they sent you</p>
            </div>
            <button
              class="w-10 h-5 rounded-full shrink-0 transition-colors relative {$messageDeletionSettings.allowDeletionByOthers ? 'bg-primary' : 'bg-gray-600'}"
              onclick={() => setAllowDeletionByOthers(!$messageDeletionSettings.allowDeletionByOthers)}
              role="switch"
              aria-checked={$messageDeletionSettings.allowDeletionByOthers}
              aria-label="Allow others to delete their messages"
            >
              <span class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform {$messageDeletionSettings.allowDeletionByOthers ? 'translate-x-5' : ''}"></span>
            </button>
          </div>
          <div class="flex items-center justify-between gap-4">
            <div class="flex-1 min-w-0">
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
          <div class="flex items-center justify-between gap-4">
            <div class="flex-1 min-w-0">
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
          <div class="flex items-center justify-between gap-4">
            <div class="flex-1 min-w-0">
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
          <div class="flex items-center justify-between gap-4">
            <div class="flex-1 min-w-0">
              <span class="text-sm">Receive message requests</span>
              <p class="text-xs text-gray-500 mt-0.5">Allow new chats from people you don't follow</p>
            </div>
            <button
              class="w-10 h-5 rounded-full transition-colors relative {$messageRequestSettings.receiveMessageRequests ? 'bg-primary' : 'bg-gray-600'}"
              onclick={() => setReceiveMessageRequests(!$messageRequestSettings.receiveMessageRequests)}
              role="switch"
              aria-checked={$messageRequestSettings.receiveMessageRequests}
              aria-label="Toggle message requests"
            >
              <span
                class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform {$messageRequestSettings.receiveMessageRequests ? 'translate-x-5' : ''}"
              ></span>
            </button>
          </div>
        </div>
      </div>
        {:else if detailPage === 'notifications'}
      <!-- Notifications Section -->
      <div class="bg-surface rounded-lg p-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <span class="font-medium">Message notifications</span>
            <p class="text-sm text-gray-400 mt-1">Get notified when you receive new messages</p>
          </div>
          <button
            class="w-12 h-6 rounded-full transition-colors relative {settings.enabled ? 'bg-primary' : 'bg-gray-600'} {isLoading ? 'opacity-50' : ''}"
            onclick={handleToggleNotifications}
            disabled={isLoading || (!!notificationSupportError && !settings.enabled)}
            role="switch"
            aria-checked={settings.enabled}
            aria-label="Toggle DM notifications"
          >
            <span
              class="absolute top-1 w-4 h-4 bg-white rounded-full transition-transform {settings.enabled ? 'left-7' : 'left-1'}"
            ></span>
          </button>
        </div>

        {#if notificationSupportError}
          <p class="mt-3 text-sm text-gray-400">{notificationSupportError}</p>
        {/if}
        {#if notificationStatus}
          <p class="mt-3 text-sm {notificationStatus.type === 'error' ? 'text-red-400' : 'text-green-500'}" role={notificationStatus.type === 'error' ? 'alert' : 'status'}>
            {notificationStatus.text}
          </p>
        {/if}

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
              {#if notificationSupportError}
                <span class="text-gray-400">Unavailable</span>
              {:else if permissionState === 'granted'}
                <span class="i-carbon-checkmark-filled text-green-500"></span>
                <span class="text-green-500">Granted</span>
              {:else if permissionState === 'denied'}
                <span class="i-carbon-close-filled text-red-500"></span>
                <span class="text-red-500">Denied</span>
              {:else}
                <span class="i-carbon-warning-filled text-yellow-500"></span>
                <span class="text-yellow-500">Not Requested</span>
                <button class="btn-primary text-xs py-1 px-2" onclick={handleRequestPermission} disabled={isLoading}>
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
                {#if !notificationSupportError && serviceWorkerRunning && permissionState === 'granted'}
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
            disabled={!!notificationSupportError || permissionState !== 'granted' || isLoading}
          >
            <span class="i-carbon-notification mr-2"></span>
            Send Test Notification
          </button>
        </div>
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
                  class="flex-1 min-w-0 bg-surface-light border border-surface-lighter rounded px-3 py-2 text-sm"
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
        {:else if detailPage === 'calls'}
      <section class="mb-6">
        <div class="space-y-4">
          {#each [{ key: 'voice' as const, label: 'Voice calls' }, { key: 'video' as const, label: 'Video calls' }, { key: 'ringtone' as const, label: 'Ring sound' }] as option}
            <div class="flex items-center justify-between gap-4">
              <span class="text-sm flex-1 min-w-0">{option.label}</span>
              <button class="w-10 h-5 rounded-full transition-colors relative {$callSettings[option.key] ? 'bg-primary' : 'bg-gray-600'}" role="switch" aria-checked={$callSettings[option.key]} aria-label={option.label} onclick={() => setCallSettings({ [option.key]: !$callSettings[option.key] })}>
                <span class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform {$callSettings[option.key] ? 'translate-x-5' : ''}"></span>
              </button>
            </div>
          {/each}
          {#if notificationApiAvailable}
            <div class="flex items-center justify-between gap-4">
              <span class="text-sm flex-1 min-w-0">Call notifications</span>
              <button class="w-10 h-5 rounded-full transition-colors relative {$callSettings.notifications && permissionState === 'granted' ? 'bg-primary' : 'bg-gray-600'}" role="switch" aria-checked={$callSettings.notifications && permissionState === 'granted'} aria-label="Call notifications" onclick={async () => {
                if ($callSettings.notifications && permissionState === 'granted') setCallSettings({ notifications: false })
                else {
                  permissionState = await Notification.requestPermission()
                  setCallSettings({ notifications: permissionState === 'granted' })
                }
              }}>
                <span class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform {$callSettings.notifications && permissionState === 'granted' ? 'translate-x-5' : ''}"></span>
              </button>
            </div>
          {/if}
          <CallQualityControls />
        </div>
      </section>

      <details class="mb-6">
        <summary class="text-sm cursor-pointer">Call servers</summary>
        <form class="mt-3 space-y-2" onsubmit={(event) => { event.preventDefault(); try { setCallServers(callServers); callServerError = '' } catch (error) { callServerError = error instanceof Error ? error.message : 'Invalid address' } }}>
          <label class="block text-sm" for="call-connection-servers">Connection servers</label>
          <textarea id="call-connection-servers" class="input w-full" aria-label="Call server addresses" rows="2" bind:value={callServers}></textarea>
          <p class="text-xs text-gray-500">A local call server lets you call without internet.</p>
          {#if callServerError}<p class="text-sm text-red-400" role="alert">{callServerError}</p>{/if}
          <button type="submit" class="btn-primary text-sm">Save</button>
        </form>
      </details>
        {:else if detailPage === 'devices'}
      <!-- Devices Section -->
      {#if $identity}
        <div class="bg-surface rounded-lg p-4">
          <p class="text-sm text-gray-400 mb-3">Link your devices to keep chats in sync.</p>

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
              {#if revocableDevicePubkeys.length > 0}
                <div class="flex items-center justify-between gap-3 pb-1">
                  <label class="flex items-center gap-2 text-xs text-gray-400">
                    <input
                      type="checkbox"
                      class="h-4 w-4 accent-primary"
                      checked={allRevocableDevicesSelected}
                      onchange={(event) =>
                        setAllRevocableDevicesSelected((event.currentTarget as HTMLInputElement).checked)}
                      disabled={registeringDevice}
                      aria-label="Select all devices"
                    />
                    <span>
                      {selectedRevocableDevicePubkeys.length > 0
                        ? `${selectedRevocableDevicePubkeys.length} selected`
                        : 'Select devices'}
                    </span>
                  </label>
                  <button
                    class="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 disabled:hover:text-red-400"
                    onclick={handleRevokeSelectedDevices}
                    disabled={registeringDevice || selectedRevocableDevicePubkeys.length === 0}
                  >
                    Revoke selected
                  </button>
                </div>
              {/if}
              {#each deviceState.registeredDevices as device}
                {@const deviceDisplay = getDeviceDisplay(device.identityPubkey)}
                {@const addedAgo = formatAddedAgo(device.createdAt)}
                <div class="flex items-center justify-between gap-2 p-2 bg-surface-light rounded">
                  {#if device.identityPubkey !== deviceState.identityPubkey}
                    <input
                      type="checkbox"
                      class="h-4 w-4 shrink-0 accent-primary"
                      checked={isDeviceSelected(device.identityPubkey)}
                      onchange={(event) =>
                        setDeviceSelected(device.identityPubkey, (event.currentTarget as HTMLInputElement).checked)}
                      disabled={registeringDevice}
                      aria-label={`Select ${deviceDisplay.title}`}
                    />
                  {/if}
                  <div class="min-w-0 flex-1">
                    <div class="text-sm text-gray-200 truncate">{deviceDisplay.title}</div>
                    {#if deviceDisplay.subtitle}
                      <div class="text-xs text-gray-400 truncate">
                        {deviceDisplay.subtitle}
                      </div>
                    {/if}
                    {#if addedAgo}
                      <div class="text-xs text-gray-500 truncate">Added {addedAgo}</div>
                    {/if}
                  </div>
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
        {:else if detailPage === 'network'}
      <!-- Relays Section -->
      <div class="bg-surface rounded-lg p-4">
        <div class="flex items-center justify-between mb-3">
          <p class="text-sm text-gray-400">Servers that deliver your messages</p>
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
                  aria-label="Remove message server"
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
          <span class="text-sm">Show connectivity in header</span>
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
        {:else if detailPage === 'about'}
      <!-- About Section -->
      <div class="bg-surface rounded-lg p-4">
        <div class="text-sm text-gray-400 space-y-3">
          <a href={NATIVE_APP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" class="inline-flex items-center gap-2 text-primary hover:underline">
            <span class="i-carbon-download" aria-hidden="true"></span>
            Get the native app
          </a>
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

      <!-- Source Code & Releases -->
      <div class="bg-surface rounded-lg p-4 space-y-3">
        <a
          href="https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2 text-primary hover:underline"
        >
          <span class="i-carbon-code text-lg"></span>
          View Source Code
        </a>
        <a
          href="https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat?tab=releases"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2 text-primary hover:underline"
        >
          <span class="i-carbon-download text-lg"></span>
          View Releases
        </a>
      </div>
        {/if}
      </div>
    </section>
  </div>
</div>

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
                placeholder="Paste link code"
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

            {#if linkKind(linkInviteInput)}
              <div class="space-y-3 mt-4">
                <button class="btn-primary w-full" disabled={linkInviteStatus === 'accepting'}
                  onclick={() => handleAcceptLinkInvite(linkInviteInput, 'history')}>Include message history</button>
                <button class="btn-secondary w-full" disabled={linkInviteStatus === 'accepting'}
                  onclick={() => handleAcceptLinkInvite(linkInviteInput, 'chats')}>Chats and groups only</button>
              </div>
            {/if}

            {#if linkInviteInput.trim() && !linkKind(linkInviteInput)}
              <p class="text-sm text-red-400 mt-4 text-center" role="alert">Invalid device link. Copy a new link from your other device.</p>
            {/if}

            {#if linkInviteStatus === 'linked'}
              <p class="text-sm text-green-400 mt-4 text-center">Device linked</p>
            {:else if linkInviteStatus === 'error'}
              <p role="alert" class="text-sm text-red-400 mt-4 text-center">{linkInviteError}</p>
            {/if}
          </div>
        </div>
      {/if}

{#if showPictureModal && modalPicture}
  <MediaModal
    src={modalPicture}
    nhash={null}
    filename={profilePictureName}
    type="image"
    onclose={() => showPictureModal = false}
  />
{/if}


<style>
  .settings-container {
    container-type: inline-size;
    container-name: settings;
    min-width: 0;
  }

  .settings-layout {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .settings-menu,
  .settings-detail {
    width: 100%;
    min-width: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .settings-menu { padding: 16px; }
  .settings-menu-group { margin-bottom: 16px; }
  .settings-menu-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    padding: 12px;
    border-radius: 10px;
    text-align: left;
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
  }
  .settings-menu-row:hover,
  .settings-menu-row:focus-visible { background: rgb(var(--color-surface-light)); }
  .settings-menu-row:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  .settings-profile-row { padding-top: 16px; padding-bottom: 16px; }
  .settings-logout { margin-top: 16px; }

  .settings-detail { display: none; }
  .settings-detail :global([role="switch"]) { flex-shrink: 0; }
  .settings-detail :global(input),
  .settings-detail :global(select),
  .settings-detail :global(textarea) { min-width: 0; max-width: 100%; }
  .settings-detail-content { max-width: 640px; margin: 0 auto; padding: 20px 16px; }
  .settings-has-page .settings-menu { display: none; }
  .settings-has-page .settings-detail { display: block; }
  .settings-wide-title { display: none; }

  @container settings (min-width: 700px) {
    .settings-menu,
    .settings-has-page .settings-menu {
      display: block;
      flex: 0 0 240px;
      border-right: 1px solid rgb(var(--color-surface-lighter));
      padding: 16px 12px;
    }
    .settings-menu-row[aria-current="page"] { background: rgb(var(--color-surface-light)); }
    .settings-profile-row { gap: 10px; padding-left: 8px; padding-right: 8px; }
    .settings-detail { display: block; flex: 1; }
    .settings-detail-content { padding: 24px; }
    .settings-wide-title { display: block; }
    .settings-narrow-title { display: none; }
  }
</style>
