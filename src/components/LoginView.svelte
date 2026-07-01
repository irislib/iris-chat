<script lang="ts">
  import { onMount } from 'svelte'
  import { hasNip07, loginWithNip07, loginWithPrivkey, generateNewIdentity, loginLinkedDevice } from '../lib/identity'
  import { isLinkInvite, parseInviteFromHash } from '../lib/chat'
  import { startDeviceLink } from '../lib/privateChats'
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
  const isLinkInviteInUrl = isLinkInvite(inviteFromUrl)
  const hasInviteInUrl = !!inviteFromUrl && !isLinkInviteInUrl
  let mode = $state<'login' | 'link'>('login')

  let linkInviteUrl = $state('')
  let linkInviteStatus = $state<'idle' | 'waiting' | 'linked' | 'error'>('idle')
  let linkInviteError = $state('')
  let linkDeviceStop: (() => void) | null = null

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

  async function startLinkInvite() {
    linkInviteStatus = 'waiting'
    linkInviteError = ''
    try {
      linkDeviceStop?.()
      const session = await startDeviceLink(async (ownerPubkey) => {
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
          linkDeviceStop?.()
          linkDeviceStop = null
        }
      })
      linkInviteUrl = session.url
      linkDeviceStop = session.stop
    } catch (e) {
      linkInviteStatus = 'error'
      linkInviteError = getErrorMessage(e, 'Failed to create link code')
    }
  }

  $effect(() => {
    if (mode !== 'link') {
      linkDeviceStop?.()
      linkDeviceStop = null
      linkInviteUrl = ''
      linkInviteStatus = 'idle'
      linkInviteError = ''
      return
    }
    if (linkInviteStatus === 'idle') {
      void startLinkInvite()
    }
    return () => {
      linkDeviceStop?.()
      linkDeviceStop = null
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
        <div class="w-full max-w-full min-w-0 overflow-hidden">
          <CopyButton text={linkInviteUrl} maxLength={32} className="w-full max-w-full min-w-0" />
        </div>
      {/if}

      {#if linkInviteStatus === 'waiting'}
        <p class="text-sm text-gray-400 text-center">Waiting for your signed-in device…</p>
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
