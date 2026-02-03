<script lang="ts">
  import { getInviteUrl, type ChatInvite } from '../lib/chat'
  import { copyToClipboard } from '../lib/utils'
  import QRCode from './QRCode.svelte'
  import QRScanner from './QRScanner.svelte'

  interface Props {
    invite: ChatInvite
    onclose: () => void
  }

  let { invite, onclose }: Props = $props()

  let showScanner = $state(false)
  let copied = $state(false)

  let inviteUrl = $derived(getInviteUrl(invite))

  async function handleCopy() {
    if (await copyToClipboard(inviteUrl)) {
      copied = true
      setTimeout(() => copied = false, 2000)
    }
  }

  async function handleShare() {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join my iris chat',
          url: inviteUrl,
        })
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          console.error('Failed to share:', e)
        }
      }
    }
  }

  function handleScanResult(url: string) {
    // Handle scanned invite URL
    showScanner = false
    // Navigate to the scanned URL
    window.location.href = url
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center p-4">
  <!-- Backdrop -->
  <button
    class="absolute inset-0 bg-black/70 border-none cursor-default"
    onclick={onclose}
    aria-label="Close"
  ></button>

  <!-- Modal -->
  <div class="relative bg-surface rounded-2xl p-6 max-w-sm w-full shadow-xl">
    <button
      class="absolute top-4 right-4 btn-ghost p-2 rounded-full"
      onclick={onclose}
      aria-label="Close"
    >
      <span class="i-carbon-close text-xl"></span>
    </button>

    <h2 class="text-xl font-bold mb-4 text-center">
      {showScanner ? 'Scan QR Code' : 'Share Invite'}
    </h2>

    {#if showScanner}
      <div class="aspect-square w-full rounded-lg overflow-hidden mb-4">
        <QRScanner onresult={handleScanResult} />
      </div>
    {:else}
      <div class="flex flex-col items-center gap-4">
        <p class="text-sm text-gray-400 text-center">
          Share this QR code or link to start a secure chat
        </p>

        <div class="bg-white p-4 rounded-xl">
          <QRCode data={inviteUrl} size={200} />
        </div>

        <div class="w-full space-y-2">
          <button
            class="btn-primary w-full flex items-center justify-center gap-2"
            onclick={handleCopy}
          >
            <span class="{copied ? 'i-carbon-checkmark' : 'i-carbon-copy'}"></span>
            {copied ? 'Copied' : 'Copy Link'}
          </button>

          {#if typeof navigator !== 'undefined' && 'share' in navigator}
            <button
              class="btn-secondary w-full flex items-center justify-center gap-2"
              onclick={handleShare}
            >
              <span class="i-carbon-share"></span>
              Share
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <div class="mt-4 pt-4 border-t border-surface-lighter">
      <button
        class="btn-ghost w-full flex items-center justify-center gap-2"
        onclick={() => showScanner = !showScanner}
      >
        <span class="{showScanner ? 'i-carbon-qr-code' : 'i-carbon-camera'}"></span>
        {showScanner ? 'Show QR Code' : 'Scan QR Code'}
      </button>
    </div>

    <p class="text-xs text-gray-500 text-center mt-4">
      Waiting for someone to join...
    </p>
  </div>
</div>
