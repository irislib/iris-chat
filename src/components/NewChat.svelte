<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import {
    invites,
    createAndSaveInvite,
    deleteStoredInvite,
    updateInviteLabel,
    getInviteUrl,
    type ChatSession,
    type ActiveInvite
  } from '../lib/chat'
  import QRCode from './QRCode.svelte'
  import Name from './Name.svelte'
  import CopyButton from './CopyButton.svelte'

  interface Props {
    onjoin: (event: CustomEvent<{ chat: ChatSession }>) => void
  }

  let { onjoin }: Props = $props()

  let inviteList = $state<ActiveInvite[]>([])
  let editingLabel = $state<string | null>(null)
  let editLabelValue = $state('')
  let creating = $state(false)
  let qrModalInvite = $state<ActiveInvite | null>(null)

  // Subscribe to invites store
  const unsubscribe = invites.subscribe((inviteMap) => {
    inviteList = Array.from(inviteMap.values()).sort((a, b) => a.createdAt - b.createdAt)
  })

  onMount(async () => {
    // Auto-create an invite if none exist
    if (inviteList.length === 0) {
      await handleCreateInvite()
    }
  })

  onDestroy(() => {
    unsubscribe()
  })

  async function handleCreateInvite() {
    if (creating) return
    creating = true
    try {
      // Generate default label "Invite #N"
      const nextNumber = inviteList.length + 1
      const defaultLabel = `Invite #${nextNumber}`
      await createAndSaveInvite(defaultLabel)
    } catch (e) {
      console.error('Failed to create invite:', e)
    } finally {
      creating = false
    }
  }

  async function handleDelete(id: string) {
    await deleteStoredInvite(id)
  }

  function openQRModal(invite: ActiveInvite) {
    qrModalInvite = invite
  }

  function closeQRModal() {
    qrModalInvite = null
  }

  function startEditLabel(invite: ActiveInvite) {
    editingLabel = invite.id
    editLabelValue = invite.label || ''
  }

  async function saveLabel(id: string) {
    await updateInviteLabel(id, editLabelValue)
    editingLabel = null
    editLabelValue = ''
  }

  function cancelEditLabel() {
    editingLabel = null
    editLabelValue = ''
  }

  function handleLabelKeydown(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter') {
      saveLabel(id)
    } else if (e.key === 'Escape') {
      cancelEditLabel()
    }
  }

  function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  // Handle ESC key to close modal
  $effect(() => {
    if (!qrModalInvite) return

    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeQRModal()
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  })
</script>

<!-- QR Modal -->
{#if qrModalInvite}
  {@const inviteUrl = getInviteUrl(qrModalInvite.invite)}
  <div
    class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
    role="dialog"
    aria-modal="true"
  >
    <!-- Backdrop click to close -->
    <button
      class="absolute inset-0 cursor-default border-none bg-transparent"
      onclick={closeQRModal}
      aria-label="Close modal"
    ></button>

    <!-- Modal content -->
    <div class="bg-surface rounded-2xl p-8 max-w-lg w-full relative z-10">
      <div class="flex justify-between items-center mb-6">
        <h3 class="text-xl font-semibold text-white">
          {qrModalInvite.label || 'Invite QR Code'}
        </h3>
        <button
          class="btn-ghost p-2"
          onclick={closeQRModal}
          aria-label="Close"
        >
          <span class="i-carbon-close text-xl"></span>
        </button>
      </div>

      <div class="flex justify-center mb-6">
        <div class="p-6 bg-white rounded-xl">
          <QRCode data={inviteUrl} size={320} />
        </div>
      </div>

      <p class="text-gray-400 text-center mb-6">
        Scan this code to start a chat
      </p>

      <CopyButton text={inviteUrl} maxLength={48} />
    </div>
  </div>
{/if}

<div class="w-full max-w-md mx-auto p-6 bg-surface rounded-2xl shadow-xl overflow-hidden">
  <h2 class="text-2xl font-bold text-white mb-4 text-center">New Chat</h2>

  {#if inviteList.length === 0 && creating}
    <div class="text-center py-8">
      <div class="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
      <p class="text-gray-400">Creating invite...</p>
    </div>
  {:else if inviteList.length === 0}
    <p class="text-gray-400 text-center mb-6">
      Create an invite link to start a secure chat.
    </p>
    <button
      class="btn-primary w-full flex items-center justify-center gap-2"
      onclick={handleCreateInvite}
      disabled={creating}
    >
      <span class="i-carbon-chat"></span>
      Create Invite
    </button>
  {:else}
    <p class="text-gray-400 text-center text-sm mb-4">
      Share an invite link to start a chat
    </p>

    <div class="space-y-3 mb-4 max-h-96 overflow-y-auto overflow-x-hidden">
      {#each inviteList as invite (invite.id)}
        <div class="bg-[#1a1a1a] rounded-lg p-3 space-y-2 overflow-hidden">
          <!-- Label row -->
          <div class="flex items-center justify-between">
            {#if editingLabel === invite.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                type="text"
                bind:value={editLabelValue}
                class="input-field flex-1 text-sm mr-2"
                placeholder="Enter label..."
                onkeydown={(e) => handleLabelKeydown(e, invite.id)}
                autofocus
              />
              <button
                class="btn-ghost px-2 text-green-400"
                onclick={() => saveLabel(invite.id)}
                aria-label="Save label"
              >
                <span class="i-carbon-checkmark"></span>
              </button>
              <button
                class="btn-ghost px-2 text-red-400"
                onclick={cancelEditLabel}
                aria-label="Cancel"
              >
                <span class="i-carbon-close"></span>
              </button>
            {:else}
              <button
                class="flex items-center gap-2 text-left flex-1 min-w-0"
                onclick={() => startEditLabel(invite)}
              >
                {#if invite.label}
                  <span class="text-white font-medium truncate">{invite.label}</span>
                {:else}
                  <span class="text-gray-500 italic">Add label...</span>
                {/if}
                <span class="i-carbon-edit text-gray-500 text-xs flex-shrink-0"></span>
              </button>
              <span class="text-gray-500 text-xs flex-shrink-0">
                {formatDate(invite.createdAt)}
              </span>
            {/if}
          </div>

          <!-- Used by section -->
          {#if invite.usedBy && invite.usedBy.length > 0}
            <div class="text-sm text-gray-400 flex items-center gap-1 flex-wrap">
              <span>Used by:</span>
              {#each invite.usedBy as pubkey, i}
                <span class="text-primary">
                  <Name {pubkey} />
                </span>
                {#if i < invite.usedBy.length - 1}
                  <span>,</span>
                {/if}
              {/each}
            </div>
          {/if}

          <!-- Action buttons -->
          <div class="flex gap-2">
            <CopyButton text={getInviteUrl(invite.invite)} maxLength={32} />
            <button
              class="w-9 h-9 rounded-full bg-surface-light hover:bg-surface-lighter flex items-center justify-center transition-colors flex-shrink-0"
              onclick={() => openQRModal(invite)}
              title="Show QR Code"
            >
              <span class="i-carbon-qr-code"></span>
            </button>
            <button
              class="w-9 h-9 rounded-full text-red-400 hover:bg-red-400/10 flex items-center justify-center transition-colors flex-shrink-0"
              onclick={() => handleDelete(invite.id)}
              title="Delete invite"
            >
              <span class="i-carbon-trash-can"></span>
            </button>
          </div>
        </div>
      {/each}
    </div>

    <!-- Create new invite button -->
    <button
      class="btn-secondary w-full flex items-center justify-center gap-2"
      onclick={handleCreateInvite}
      disabled={creating}
    >
      {#if creating}
        <div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
      {:else}
        <span class="i-carbon-add"></span>
      {/if}
      Create New Invite
    </button>
  {/if}
</div>
