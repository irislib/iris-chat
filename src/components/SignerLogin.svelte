<script lang="ts">
  import { onMount } from 'svelte'
  import { loginWithRemoteSigner } from '../lib/signerLogin'
  import { getErrorMessage } from '../lib/utils'
  import QRCode from './QRCode.svelte'
  import CopyButton from './CopyButton.svelte'

  let { onlogin, onback }: { onlogin: () => void; onback: () => void } = $props()
  let link = $state('')
  let pastedLink = $state('')
  let pasting = $state(false)
  let error = $state('')
  let authUrl = $state('')
  let busy = $state(false)
  let committing = $state(false)
  let attempt: AbortController | null = null

  async function start(bunkerLink?: string) {
    if (committing) return
    attempt?.abort()
    const controller = new AbortController()
    attempt = controller
    link = ''
    authUrl = ''
    error = ''
    busy = true
    try {
      await loginWithRemoteSigner({
        bunkerLink,
        signal: controller.signal,
        onConnectionLink: value => { if (!controller.signal.aborted) link = value },
        onAuthUrl: value => { if (!controller.signal.aborted) authUrl = value },
        onCommitting: () => { committing = true; authUrl = '' },
      })
      if (!controller.signal.aborted) onlogin()
    } catch (cause) {
      if (!controller.signal.aborted) error = getErrorMessage(cause, 'Could not connect to signer. Try again.')
    } finally {
      if (attempt === controller) { busy = false; committing = false }
    }
  }

  function showPaste() {
    if (committing) return
    attempt?.abort()
    pasting = true
    busy = false
    error = ''
    authUrl = ''
  }

  onMount(() => {
    void start()
    return () => attempt?.abort()
  })
</script>

<div class="space-y-3">
  <h2 class="text-2xl font-bold text-white text-center">Signer app/device</h2>
  {#if pasting}
    <form class="space-y-3" onsubmit={event => { event.preventDefault(); void start(pastedLink) }}>
      <input class="input-field" aria-label="Signer link" placeholder="Paste signer link" bind:value={pastedLink} disabled={busy} autocomplete="off" spellcheck="false" />
      <button class="btn-primary w-full" disabled={busy || !pastedLink.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>
    </form>
  {:else}
    <p class="text-sm text-gray-400 text-center">Scan with your signer app.</p>
    <div class="flex justify-center">
      <div class="p-4 bg-white rounded-xl">
        {#if link}
          <QRCode data={link} size={200} />
        {:else}
          <div class="w-50 h-50 bg-gray-200 animate-pulse rounded-lg"></div>
        {/if}
      </div>
    </div>
    {#if link}
      <div class="w-full min-w-0 overflow-hidden">
        <CopyButton text={link} maxLength={32} className="w-full max-w-full min-w-0" />
      </div>
    {/if}
    <button class="btn-ghost w-full" onclick={showPaste} disabled={committing}>Paste signer link</button>
  {/if}
  {#if authUrl}
    <a class="btn-primary block text-center w-full" href={authUrl} target="_blank" rel="noopener noreferrer">Approve in signer</a>
  {/if}
  {#if error}
    <div role="alert" class="text-red-400 text-sm">{error}</div>
    {#if !pasting}<button class="btn-secondary w-full" onclick={() => start()}>Try again</button>{/if}
  {:else if busy && (link || pasting)}
    <p class="text-sm text-gray-400 text-center">{committing ? 'Finishing…' : 'Waiting for approval…'}</p>
  {/if}
  <button class="btn-ghost w-full" disabled={committing} onclick={() => { if (!committing) { attempt?.abort(); onback() } }}>Cancel</button>
</div>
