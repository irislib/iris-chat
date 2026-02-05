<script lang="ts">
  import { onMount } from 'svelte'
  import { hasNip07, loginWithNip07, loginWithPrivkey, generateNewIdentity, loginLinkedDevice } from '../lib/identity'
  import { parseInviteFromHash } from '../lib/chat'
  import { createLinkInvite, listenForLinkInviteAcceptance } from '../lib/privateChats'
  import { getErrorMessage } from '../lib/utils'
  import QRCode from './QRCode.svelte'
  import CopyButton from './CopyButton.svelte'

  interface Props {
    onlogin: () => void
  }

  let { onlogin }: Props = $props()

  let displayName = $state('')
  let loading = $state(false)
  let error = $state('')
  let inputEl = $state<HTMLInputElement | null>(null)

  const supportsNip07 = hasNip07()
  const inviteFromUrl = parseInviteFromHash()
  const isLinkInviteInUrl =
    inviteFromUrl?.type === 'legacy' && inviteFromUrl.invite.purpose === 'link'
  const hasInviteInUrl = !!inviteFromUrl && !isLinkInviteInUrl
  let mode = $state<'login' | 'link'>('login')

  let linkInviteUrl = $state('')
  let linkInviteStatus = $state<'idle' | 'waiting' | 'linked' | 'error'>('idle')
  let linkInviteError = $state('')
  let linkInviteUnsub: (() => void) | null = null

  onMount(() => {
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    if (!isTouchDevice && inputEl && mode === 'login') {
      inputEl.focus()
    }
  })

  async function handleNip07Login() {
    loading = true
    error = ''
    try {
      await loginWithNip07(displayName || null)
      onlogin()
    } catch (e) {
      error = getErrorMessage(e, 'Failed to login with extension')
    } finally {
      loading = false
    }
  }

  async function handleGenerateIdentity() {
    loading = true
    error = ''
    try {
      const { privkey } = generateNewIdentity()
      await loginWithPrivkey(privkey, displayName || null)
      onlogin()
    } catch (e) {
      error = getErrorMessage(e, 'Failed to generate identity')
    } finally {
      loading = false
    }
  }

  function getLinkInviteBaseUrl(): string {
    const origin = window.location.origin
    if (
      origin.startsWith('tauri://') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1')
    ) {
      return 'https://chat.iris.to'
    }
    return origin
  }

  async function startLinkInvite() {
    linkInviteStatus = 'waiting'
    linkInviteError = ''
    try {
      const invite = await createLinkInvite()
      linkInviteUrl = invite.getUrl(getLinkInviteBaseUrl())

      linkInviteUnsub?.()
      linkInviteUnsub = listenForLinkInviteAcceptance(invite, async (ownerPubkey) => {
        try {
          await loginLinkedDevice(ownerPubkey, displayName || null)
          if (window.location.hash) {
            history.replaceState(null, '', window.location.pathname)
          }
          linkInviteStatus = 'linked'
          onlogin()
        } catch (e) {
          linkInviteStatus = 'error'
          linkInviteError = getErrorMessage(e, 'Failed to link device')
        } finally {
          linkInviteUnsub?.()
          linkInviteUnsub = null
        }
      })
    } catch (e) {
      linkInviteStatus = 'error'
      linkInviteError = getErrorMessage(e, 'Failed to create link invite')
    }
  }

  $effect(() => {
    if (mode !== 'link') {
      linkInviteUnsub?.()
      linkInviteUnsub = null
      linkInviteUrl = ''
      linkInviteStatus = 'idle'
      linkInviteError = ''
      return
    }
    if (linkInviteStatus === 'idle') {
      void startLinkInvite()
    }
    return () => {
      linkInviteUnsub?.()
      linkInviteUnsub = null
    }
  })
</script>

<div class="w-full max-w-md mx-auto p-6 bg-surface rounded-2xl shadow-xl">
  {#if mode === 'link'}
    <div class="space-y-4">
      <h2 class="text-2xl font-bold text-white text-center">Link this device</h2>
      <p class="text-sm text-gray-400 text-center">
        Scan this code with your main device to connect it.
      </p>

      <div class="flex justify-center">
        <div class="p-4 bg-white rounded-xl">
          {#if linkInviteUrl}
            <QRCode data={linkInviteUrl} size={240} />
          {:else}
            <div class="w-60 h-60 bg-surface-light animate-pulse rounded-lg"></div>
          {/if}
        </div>
      </div>

      {#if linkInviteUrl}
        <CopyButton text={linkInviteUrl} maxLength={48} className="w-full" />
      {/if}

      {#if linkInviteStatus === 'waiting'}
        <p class="text-sm text-gray-400 text-center">Waiting for approval…</p>
      {:else if linkInviteStatus === 'linked'}
        <p class="text-sm text-green-400 text-center">Device linked</p>
      {:else if linkInviteStatus === 'error'}
        <div class="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-400 text-sm">
          {linkInviteError}
        </div>
      {/if}

      <button
        class="btn-ghost w-full flex items-center justify-center gap-2"
        onclick={() => mode = 'login'}
        disabled={loading}
      >
        <span class="i-carbon-arrow-left"></span>
        Back to login
      </button>
    </div>
  {:else}
    <div class="space-y-4">
      <div>
        <label for="displayName" class="block text-sm text-gray-400 mb-1">
          Your name (optional)
        </label>
        <input
          id="displayName"
          type="text"
          bind:this={inputEl}
          bind:value={displayName}
          placeholder="Name"
          class="input-field"
          disabled={loading}
          onkeydown={(e) => e.key === 'Enter' && handleGenerateIdentity()}
        />
      </div>

      {#if error}
        <div class="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      {/if}

      <div class="space-y-3 pt-2">
        {#if supportsNip07}
          <button
            class="btn-primary w-full flex items-center justify-center gap-2"
            onclick={handleNip07Login}
            disabled={loading}
          >
            <span class="i-carbon-wallet"></span>
            Login with Extension
          </button>

          <button
            class="btn-secondary w-full flex items-center justify-center gap-2"
            onclick={handleGenerateIdentity}
            disabled={loading}
          >
            <span class="i-carbon-user-avatar"></span>
            Join Anonymously
          </button>
        {:else}
          <button
            class="btn-primary w-full flex items-center justify-center"
            onclick={handleGenerateIdentity}
            disabled={loading}
          >
            {hasInviteInUrl ? 'Join Chat' : 'Go'}
          </button>
        {/if}

        <button
          class="btn-ghost w-full flex items-center justify-center gap-2"
          onclick={() => mode = 'link'}
          disabled={loading}
        >
          <span class="i-carbon-qr-code"></span>
          Link this device
        </button>
      </div>
    </div>
  {/if}
</div>
