<script lang="ts">
  import { parseInviteFromUrl, parseInviteFromHash, acceptInvite, type ChatSession } from '../lib/chat'
  import { getErrorMessage } from '../lib/utils'
  import QRScanner from './QRScanner.svelte'

  interface Props {
    onjoin: (event: CustomEvent<{ chat: ChatSession }>) => void
  }

  let { onjoin }: Props = $props()

  let linkInput = $state('')
  let error = $state('')
  let joining = $state(false)
  let showScanner = $state(false)

  async function joinWithUrl(url: string) {
    const invite = parseInviteFromUrl(url)
    if (!invite) {
      error = 'Invalid invite link'
      return
    }
    if (invite.type === 'legacy' && invite.invite.purpose === 'link') {
      error = 'This link is for device linking'
      return
    }

    joining = true
    error = ''
    try {
      const session = await acceptInvite(invite)
      linkInput = ''
      // Clear URL hash if present
      if (window.location.hash) {
        history.replaceState(null, '', window.location.pathname)
      }
      onjoin(new CustomEvent('join', { detail: { chat: session } }))
    } catch (e) {
      error = getErrorMessage(e, 'Failed to join chat')
      console.error('Failed to join chat:', e)
    } finally {
      joining = false
    }
  }

  function handleQRResult(data: string) {
    showScanner = false
    joinWithUrl(data)
  }

  // Auto-join when valid link is pasted
  $effect(() => {
    const trimmed = linkInput.trim()
    if (!trimmed) return
    const invite = parseInviteFromUrl(trimmed)
    if (invite) {
      joinWithUrl(trimmed)
    }
  })

  // Check URL hash on mount
  $effect(() => {
    const hashInvite = parseInviteFromHash()
    if (hashInvite) {
      if (hashInvite.type === 'legacy' && hashInvite.invite.purpose === 'link') {
        return
      }
      acceptInvite(hashInvite).then(session => {
        history.replaceState(null, '', window.location.pathname)
        onjoin(new CustomEvent('join', { detail: { chat: session } }))
      }).catch(e => {
        error = getErrorMessage(e, 'Failed to join chat')
        console.error('Failed to join from URL:', e)
      })
    }
  })
</script>

<div class="w-full max-w-md p-6 bg-surface rounded-2xl shadow-xl overflow-hidden">
  <h2 class="text-2xl font-bold text-white mb-4 text-center">Join Chat</h2>

  <div class="space-y-4">
    {#if showScanner}
      <div class="aspect-square rounded-lg overflow-hidden">
        <QRScanner onresult={handleQRResult} />
      </div>
      <button
        class="btn-secondary w-full flex items-center justify-center gap-2"
        onclick={() => showScanner = false}
      >
        <span class="i-carbon-text-link"></span>
        Paste Link Instead
      </button>
    {:else}
      <input
        type="text"
        bind:value={linkInput}
        placeholder="Paste invite link"
        class="input-field"
        disabled={joining}
      />

      <button
        class="btn-secondary w-full flex items-center justify-center gap-2"
        onclick={() => showScanner = true}
      >
        <span class="i-carbon-qr-code"></span>
        Scan QR Code
      </button>
    {/if}

    {#if error}
      <div class="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-400 text-sm">
        {error}
      </div>
    {/if}
  </div>
</div>
