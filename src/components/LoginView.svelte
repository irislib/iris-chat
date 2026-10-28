<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { nip19 } from 'nostr-tools'
  import { bytesToHex, hasNip07, loginWithNip07, loginWithPrivkey, generateNewIdentity } from '../lib/identity'
  import { isLinkInvite, parseInviteFromHash } from '../lib/chat'
  import { getErrorMessage } from '../lib/utils'
  import SignerLogin from './SignerLogin.svelte'

  interface Props {
    onlogin: () => void
    inviteTitle?: string
    groupInvite?: boolean
  }

  let { onlogin, inviteTitle = '', groupInvite = false }: Props = $props()

  let displayName = $state('')
  let loading = $state(false)
  let error = $state('')
  let inputEl = $state<HTMLInputElement | null>(null)
  let secretKey = $state('')
  let secretInputEl = $state<HTMLInputElement | null>(null)

  const supportsNip07 = hasNip07()
  const inviteFromUrl = parseInviteFromHash()
  const isLinkInviteInUrl = isLinkInvite(inviteFromUrl)
  const hasInviteInUrl = !!inviteFromUrl && !isLinkInviteInUrl
  let mode = $state<'login' | 'existing' | 'secret' | 'signer'>('login')

  export async function focusName() {
    await tick()
    // Native dialog closing restores focus after the click's default action.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    if (!isTouchDevice && inputEl && mode === 'login') {
      inputEl.focus()
    }
  }

  onMount(() => { void focusName() })

  async function showSecretKeyLogin() {
    error = ''
    mode = 'secret'
    await tick()
    secretInputEl?.focus()
  }

  async function handleSecretKeyLogin() {
    if (loading || !secretKey.trim()) return
    loading = true
    error = ''
    try {
      let key = secretKey.trim()
      if (key.toLowerCase().startsWith('nsec1')) {
        const decoded = nip19.decode(key)
        if (decoded.type !== 'nsec') throw new Error('Invalid secret key')
        key = bytesToHex(decoded.data)
      }
      await loginWithPrivkey(key.toLowerCase())
      secretKey = ''
      onlogin()
    } catch {
      // Decoder errors can include the input. Never echo a secret key.
      error = 'Enter a valid secret key (nsec or hex).'
    } finally {
      loading = false
    }
  }

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
      await loginWithPrivkey(privkey, displayName || null, true)
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
    <SignerLogin {onlogin} onback={() => mode = 'existing'} />
  {:else if mode === 'secret'}
    <form class="space-y-4" onsubmit={event => { event.preventDefault(); void handleSecretKeyLogin() }}>
      <h2 class="text-2xl font-bold text-white text-center">Log in with secret key</h2>
      <div>
        <label for="secretKey" class="block text-sm text-gray-400 mb-1">Secret key</label>
        <input
          id="secretKey"
          type="password"
          bind:this={secretInputEl}
          bind:value={secretKey}
          placeholder="nsec or hex"
          class="input-field"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          disabled={loading}
        />
      </div>
      {#if error}<div role="alert" class="text-red-400 text-sm">{error}</div>{/if}
      <button type="submit" class="btn-primary w-full" disabled={loading || !secretKey.trim()}>
        {loading ? 'Logging in…' : 'Log in'}
      </button>
      <button type="button" class="btn-ghost w-full" disabled={loading} onclick={() => { secretKey = ''; error = ''; mode = 'existing' }}>Back</button>
    </form>
  {:else if mode === 'existing'}
    <div class="space-y-4">
      <h2 class="text-2xl font-bold text-white text-center">Existing account</h2>
      {#if error}<div role="alert" class="text-red-400 text-sm">{error}</div>{/if}
      <div class="space-y-3">
        {#if supportsNip07}
          <button class="btn-secondary w-full flex items-center justify-center gap-2" onclick={handleNip07Login} disabled={loading}>
            <span class="i-carbon-wallet"></span>
            Login with Extension
          </button>
        {/if}
        <button class="btn-secondary w-full flex items-center justify-center gap-2" onclick={showSecretKeyLogin} disabled={loading}>
          <span class="i-carbon-password"></span>
          Log in with secret key
        </button>
        <button class="btn-secondary w-full flex items-center justify-center gap-2" onclick={() => { error = ''; mode = 'signer' }} disabled={loading}>
          <span class="i-carbon-devices"></span>
          Link this device
        </button>
        <button class="btn-ghost w-full" disabled={loading} onclick={() => { error = ''; mode = 'login'; void focusName() }}>Back</button>
      </div>
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

      {#if inviteTitle}<p class="text-center text-gray-300">{inviteTitle}</p>{/if}
      {#if error}
        <div class="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      {/if}

      <div class="space-y-3 pt-2">
        <button
          class="btn-primary w-full flex items-center justify-center"
          onclick={handleGenerateIdentity}
          disabled={loading}
        >
          {groupInvite ? 'Join Group' : hasInviteInUrl ? 'Join Chat' : 'Go'}
        </button>

        <button
          class="btn-ghost w-full flex items-center justify-center gap-2"
          onclick={() => { error = ''; mode = 'existing' }}
          disabled={loading}
        >
          Already have an account?
        </button>
      </div>
    </div>
  {/if}
</div>
