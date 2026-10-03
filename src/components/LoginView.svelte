<script lang="ts">
  import { onMount } from 'svelte'
  import { hasNip07, loginWithNip07, loginWithPrivkey, generateNewIdentity } from '../lib/identity'
  import { isLinkInvite, parseInviteFromHash } from '../lib/chat'
  import { getErrorMessage } from '../lib/utils'
  import SignerLogin from './SignerLogin.svelte'

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
  let mode = $state<'login' | 'signer'>('login')

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

</script>

<div class="w-full max-w-md mx-auto p-6 bg-surface rounded-2xl shadow-xl">
  {#if mode === 'signer'}
    <SignerLogin {onlogin} onback={() => mode = 'login'} />
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
          onclick={() => mode = 'signer'}
          disabled={loading}
        >
          <span class="i-carbon-qr-code"></span>
          Link this device
        </button>
      </div>
    </div>
  {/if}
</div>
