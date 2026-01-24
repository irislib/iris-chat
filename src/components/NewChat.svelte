<script lang="ts">
  import { createInvite, getInviteUrl, listenForInviteAcceptance, type ChatSession } from '../lib/chat'
  import QRCode from './QRCode.svelte'

  interface Props {
    onjoin: (event: CustomEvent<{ chat: ChatSession }>) => void
  }

  let { onjoin }: Props = $props()

  let inviteUrl = $state('')
  let copied = $state(false)
  let inviteUnsubscribe = $state<(() => void) | null>(null)

  function handleCreate() {
    // Clean up previous listener
    if (inviteUnsubscribe) {
      inviteUnsubscribe()
    }

    const invite = createInvite()
    inviteUrl = getInviteUrl(invite)

    // Listen for acceptance
    inviteUnsubscribe = listenForInviteAcceptance(invite, (session) => {
      inviteUrl = ''
      onjoin(new CustomEvent('join', { detail: { chat: session } }))
    })
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      copied = true
      setTimeout(() => copied = false, 2000)
    } catch (e) {
      console.error('Failed to copy:', e)
    }
  }

  function handleCancel() {
    if (inviteUnsubscribe) {
      inviteUnsubscribe()
      inviteUnsubscribe = null
    }
    inviteUrl = ''
  }
</script>

<div class="w-full max-w-md mx-auto p-6 bg-surface rounded-2xl shadow-xl">
  <h2 class="text-2xl font-bold text-white mb-4 text-center">New Chat</h2>

  {#if inviteUrl}
    <div class="space-y-4">
      <p class="text-gray-400 text-center text-sm">
        Share this link or scan QR code
      </p>

      <!-- QR Code -->
      <div class="flex justify-center">
        <div class="p-3 bg-white rounded-lg">
          <QRCode data={inviteUrl} size={160} />
        </div>
      </div>

      <div class="flex gap-2">
        <input
          type="text"
          value={inviteUrl}
          readonly
          class="input-field flex-1 text-sm"
        />
        <button
          class="btn-secondary px-4"
          onclick={handleCopy}
        >
          {#if copied}
            <span class="i-carbon-checkmark"></span>
          {:else}
            <span class="i-carbon-copy"></span>
          {/if}
        </button>
      </div>

      <div class="text-center">
        <p class="text-sm text-gray-500 mb-2">Waiting for someone to join...</p>
        <div class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto"></div>
      </div>

      <button
        class="btn-ghost w-full text-sm"
        onclick={handleCancel}
      >
        Cancel
      </button>
    </div>
  {:else}
    <p class="text-gray-400 text-center mb-6">
      Create an invite link to start a secure chat.
    </p>

    <button
      class="btn-primary w-full flex items-center justify-center gap-2"
      onclick={handleCreate}
    >
      <span class="i-carbon-chat"></span>
      Create Invite
    </button>
  {/if}
</div>
