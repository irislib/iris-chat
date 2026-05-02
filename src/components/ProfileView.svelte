<script lang="ts">
  import { nip19 } from 'nostr-tools'
  import Avatar from './Avatar.svelte'
  import CopyButton from './CopyButton.svelte'
  import MediaModal from './MediaModal.svelte'
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'
  import { chats } from '../lib/chat'
  import { generateProxyUrl } from '../lib/imgproxy'
  import { createRuntimeProfileAppKeysStore } from '../lib/profileAppKeysRuntime'
  import type { ProfileAppKeyDevice, ProfileAppKeysState } from '../lib/profileAppKeys'
  import { describeRegisteredDevice } from '../lib/deviceLabels'

  interface Props {
    pubkey: string
    onBack: () => void
    onOpenChat: (pubkey: string) => void
  }

  let { pubkey, onBack, onOpenChat }: Props = $props()

  // Validate pubkey is a valid hex string
  let isValidPubkey = $derived(typeof pubkey === 'string' && /^[0-9a-f]{64}$/i.test(pubkey))

  // Only create derived values if pubkey is valid
  let profileStore = $derived(isValidPubkey ? createProfileStore(pubkey) : undefined)
  let profile = $derived(profileStore ? $profileStore ?? undefined : undefined)
  let profileName = $derived(isValidPubkey ? getProfileName(profile) : undefined)
  let animalName = $derived(isValidPubkey ? getAnimalName(pubkey) : 'Unknown')
  let profileAppKeysStore = $derived(
    isValidPubkey ? createRuntimeProfileAppKeysStore(pubkey) : undefined
  )
  const emptyProfileAppKeys: ProfileAppKeysState = { devices: [], loading: false }
  let profileAppKeys = $derived(
    profileAppKeysStore ? ($profileAppKeysStore ?? emptyProfileAppKeys) : emptyProfileAppKeys
  )

  // Check if we have an existing chat with this user
  let hasExistingChat = $derived(isValidPubkey ? $chats.has(pubkey) : false)

  let npub = $derived(isValidPubkey ? nip19.npubEncode(pubkey) : '')

  // Profile picture modal
  let showPictureModal = $state(false)
  let profilePicture = $derived(profile?.picture)
  let proxiedFullPicture = $state<string | null>(null)

  $effect(() => {
    const pic = profilePicture
    proxiedFullPicture = null
    if (pic) {
      generateProxyUrl(pic, { width: 800 }).then(url => {
        proxiedFullPicture = url
      })
    }
  })

  function handleOpenChat() {
    onOpenChat(pubkey)
  }

  function handleAvatarClick() {
    if (profilePicture) {
      showPictureModal = true
    }
  }

  function formatDeviceCreatedAt(createdAt: number) {
    if (!createdAt) return 'Published time unknown'

    const date = new Date(createdAt * 1000)
    if (Number.isNaN(date.getTime())) return 'Published time unknown'

    return `Published ${date.toLocaleString()}`
  }

  function formatDeviceIdentity(identityPubkey: string) {
    try {
      return nip19.npubEncode(identityPubkey)
    } catch {
      return identityPubkey
    }
  }

  function getDeviceDisplay(device: ProfileAppKeyDevice) {
    return describeRegisteredDevice(device.identityPubkey, device.labels)
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
    <h1 class="text-xl font-semibold">Profile</h1>
  </header>

  <!-- Content -->
  <div class="flex-1 overflow-y-auto overscroll-contain p-4">
    {#if isValidPubkey}
      <div class="max-w-lg mx-auto space-y-6">
        <!-- Profile Card -->
        <div class="bg-surface rounded-2xl p-6 text-center">
          <!-- Avatar -->
          <div class="flex justify-center mb-4">
            {#if profilePicture}
              <button
                class="rounded-full overflow-hidden cursor-pointer hover:opacity-90 transition-opacity"
                onclick={handleAvatarClick}
                aria-label="View profile picture"
              >
                <Avatar {pubkey} size={96} />
              </button>
            {:else}
              <Avatar {pubkey} size={96} />
            {/if}
          </div>

          <!-- Name -->
          <h2 class="text-2xl font-bold mb-1">
            {#if profileName}
              {profileName}
            {:else}
              <span class="italic opacity-70">{animalName}</span>
            {/if}
          </h2>

          <!-- NIP-05 -->
          {#if profile?.nip05}
            <p class="text-primary text-sm mb-4">{profile.nip05}</p>
          {:else}
            <div class="mb-4"></div>
          {/if}

          <!-- About -->
          {#if profile?.about}
            <p class="text-gray-300 text-sm whitespace-pre-wrap break-words mb-6 text-left bg-surface-light rounded-lg p-4">
              {profile.about}
            </p>
          {/if}

          <!-- npub Copy Button -->
          <div class="mb-4 flex">
            <CopyButton text={npub} maxLength={48} />
          </div>

          <details
            class="mb-4 rounded-xl border border-surface-lighter bg-surface-light/60 text-left"
            data-testid="profile-appkeys-disclosure"
          >
            <summary class="cursor-pointer px-4 py-3 select-none">
              <span class="text-sm font-medium text-gray-200">Known App Keys</span>
              <span class="block text-xs text-gray-400 mt-1">
                {#if profileAppKeys.devices.length > 0}
                  {profileAppKeys.devices.length}
                  {profileAppKeys.devices.length === 1 ? ' device key published' : ' device keys published'}
                {:else if profileAppKeys.loading}
                  Checking connected relays...
                {:else}
                  No published app keys seen yet
                {/if}
              </span>
            </summary>

            <div class="border-t border-surface-lighter px-4 py-3 space-y-3">
              {#if profileAppKeys.devices.length > 0}
                {#if profileAppKeys.loading}
                  <p class="text-xs text-gray-500">Refreshing from connected relays...</p>
                {/if}

                {#each profileAppKeys.devices as device}
                  {@const deviceDisplay = getDeviceDisplay(device)}
                  <div class="space-y-2">
                    <div class="min-w-0">
                      <div class="text-sm text-gray-200 truncate">{deviceDisplay.title}</div>
                      {#if deviceDisplay.subtitle}
                        <div class="text-xs text-gray-400 truncate">{deviceDisplay.subtitle}</div>
                      {/if}
                    </div>
                    <CopyButton
                      text={formatDeviceIdentity(device.identityPubkey)}
                      label="Copy device code"
                      maxLength={48}
                      className="text-xs"
                    />
                    <p class="text-xs text-gray-500">{formatDeviceCreatedAt(device.createdAt)}</p>
                  </div>
                {/each}
              {:else if profileAppKeys.loading}
                <p class="text-sm text-gray-400">
                  Checking connected relays for device keys...
                </p>
              {:else}
                <p class="text-sm text-gray-400">
                  No app keys for this profile have been seen on your connected relays yet.
                </p>
              {/if}
            </div>
          </details>

          <!-- Chat Button -->
          <button
            class="w-full btn-primary flex items-center justify-center gap-2"
            onclick={handleOpenChat}
          >
            <span class="i-carbon-chat"></span>
            {hasExistingChat ? 'Open Chat' : 'Start Chat'}
          </button>
        </div>
      </div>
    {:else}
      <div class="max-w-lg mx-auto text-center py-8">
        <p class="text-gray-400">Invalid profile</p>
        <button
          class="mt-4 btn-secondary"
          onclick={onBack}
        >
          Go Back
        </button>
      </div>
    {/if}
  </div>
</div>

{#if showPictureModal && (proxiedFullPicture || profilePicture)}
  <MediaModal
    src={(proxiedFullPicture || profilePicture) ?? null}
    nhash={null}
    filename={profileName || animalName}
    type="image"
    onclose={() => showPictureModal = false}
  />
{/if}
