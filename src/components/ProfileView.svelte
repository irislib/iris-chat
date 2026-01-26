<script lang="ts">
  import { nip19 } from 'nostr-tools'
  import Avatar from './Avatar.svelte'
  import CopyButton from './CopyButton.svelte'
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'
  import { chats } from '../lib/chat'

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

  // Check if we have an existing chat with this user
  let hasExistingChat = $derived(isValidPubkey ? $chats.has(pubkey) : false)

  let npub = $derived(isValidPubkey ? nip19.npubEncode(pubkey) : '')

  function handleOpenChat() {
    onOpenChat(pubkey)
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
            <Avatar {pubkey} size={96} />
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
