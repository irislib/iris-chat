<script lang="ts">
  import {
    acceptDirectFiles, declineDirectFiles, cancelDirectFiles, downloadDirectFile,
    type DirectFileTransfer,
  } from '../lib/directFiles'
  import { formatDirectFileSize } from '../lib/directFileDraft'
  import { getErrorMessage } from '../lib/utils'

  let { transfer }: { transfer: DirectFileTransfer } = $props()
  let busy = $state(false)
  let cancelling = $state(false)
  let actionError = $state('')
  let active = $derived(transfer.status === 'connecting' || transfer.status === 'transferring')
  let canAccept = $derived(transfer.status === 'offered' && !transfer.isSender)
  let canCancel = $derived(active || (transfer.status === 'offered' && transfer.isSender))
  let label = $derived.by(() => {
    switch (transfer.status) {
      case 'offered': return transfer.isSender ? 'Waiting for acceptance' : 'Ready to receive'
      case 'connecting': return 'Connecting…'
      case 'transferring': return transfer.isSender ? 'Sending…' : 'Receiving…'
      case 'completed': return transfer.isSender ? 'Sent' : 'Received'
      case 'declined': return 'Declined'
      case 'cancelled': return 'Cancelled'
      case 'failed': return 'Transfer failed'
      case 'unavailable': return 'Files unavailable'
    }
  })
  async function act(action: () => Promise<void>) {
    if (busy) return
    busy = true
    actionError = ''
    try { await action() }
    catch (error) {
      if (transfer.status !== 'cancelled') actionError = getErrorMessage(error, 'Couldn’t complete this action. Try again.')
    }
    finally { busy = false }
  }
  async function cancel() {
    if (cancelling) return
    cancelling = true
    actionError = ''
    try { await cancelDirectFiles(transfer.id) }
    catch (error) { actionError = getErrorMessage(error, 'Couldn’t cancel. Try again.') }
    finally { cancelling = false }
  }
</script>

<div class="w-64 max-w-full space-y-3" data-testid={`direct-file-transfer-${transfer.id}`}>
  <div class="font-medium text-sm flex items-center gap-2">
    <span class="i-carbon-arrows-vertical" aria-hidden="true"></span>
    Direct files
  </div>
  {#each transfer.files as file, index}
    <div class="flex items-center gap-2 min-w-0">
      <span class="i-carbon-document flex-shrink-0 text-lg" aria-hidden="true"></span>
      <div class="min-w-0 flex-1">
        <div class="text-sm break-words">{file.filename}</div>
        <div class="text-xs opacity-70">{formatDirectFileSize(file.sizeBytes)}</div>
      </div>
      {#if transfer.status === 'completed'}
        <button class="p-2 rounded-full hover:bg-black/10 disabled:opacity-50" disabled={busy}
          aria-label={`Download ${file.filename}`} onclick={() => act(() => downloadDirectFile(transfer.id, index))}>
          <span class="i-carbon-download text-lg" aria-hidden="true"></span>
        </button>
      {/if}
    </div>
  {/each}
  <p class="text-xs opacity-80" role="status">{label}</p>
  {#if active}
    <progress class="w-full h-1.5" value={transfer.transferredBytes} max={Math.max(1, transfer.totalBytes)} aria-label="File transfer progress"></progress>
    <p class="text-xs opacity-80">{formatDirectFileSize(transfer.transferredBytes)} of {formatDirectFileSize(transfer.totalBytes)}</p>
  {/if}
  {#if canAccept}
    <div class="flex gap-2">
      <button class="px-3 py-1.5 rounded-lg bg-black/15 hover:bg-black/25 text-sm font-medium disabled:opacity-50" disabled={busy} onclick={() => act(() => acceptDirectFiles(transfer.id))}>Accept</button>
      <button class="px-3 py-1.5 rounded-lg hover:bg-black/10 text-sm disabled:opacity-50" disabled={busy} onclick={() => act(() => declineDirectFiles(transfer.id))}>Decline</button>
    </div>
  {:else if canCancel}
    <button class="px-3 py-1.5 rounded-lg hover:bg-black/10 text-sm disabled:opacity-50" disabled={cancelling} onclick={cancel}>Cancel</button>
  {/if}
  {#if actionError || transfer.error}<p role="alert" class="text-xs">{actionError || transfer.error}</p>{/if}
</div>
