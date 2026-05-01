<script lang="ts">
  import type { ChatMessage } from '../lib/chat'
  import { copyToClipboard } from '../lib/utils'
  import { deriveMessageReceiptInfo, partitionReceiptStages } from '../lib/messageInfo'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'

  interface Props {
    message: ChatMessage
    myPubkey?: string | null
    recipientPubkey?: string | null
    groupMembers?: string[]
    onclose: () => void
  }

  let { message, myPubkey = null, recipientPubkey = null, groupMembers = [], onclose }: Props = $props()

  let showRawData = $state(false)
  let copiedMessageId = $state(false)

  let receiptInfo = $derived(
    deriveMessageReceiptInfo(message, {
      myPubkey,
      recipientPubkey,
      groupMembers,
    })
  )
  let receiptStages = $derived(partitionReceiptStages(receiptInfo.receivedBy, receiptInfo.seenBy))
  let sentRelayUrls = $derived(message.sentToRelays || [])
  let deliveryChannels = $derived(
    Array.from(
      new Set([
        ...(message.deliveryChannels || []),
        ...sentRelayUrls.map((relayUrl) => `message server: ${relayUrl}`),
      ].map((channel) => channel.trim()).filter(Boolean))
    ).sort()
  )

  let messageScopeLabel = $derived(
    receiptInfo.scope === 'dm'
      ? 'Private chat'
      : receiptInfo.scope === 'group'
        ? 'Group chat'
        : 'Unknown scope'
  )

  let statusLabel = $derived(
    message.status || (sentRelayUrls.length > 0 ? 'sent' : message.isMine ? 'sending' : 'received')
  )

  let rawData = $derived(
    JSON.stringify(
      {
        message,
        receiptInfo,
      },
      null,
      2
    )
  )

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onclose()
  }

  function formatDateTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  async function handleCopyMessageId() {
    const ok = await copyToClipboard(message.id)
    if (!ok) return
    copiedMessageId = true
    setTimeout(() => {
      copiedMessageId = false
    }, 2000)
  }

  function shortPubkey(pubkey: string): string {
    if (pubkey.length <= 16) return pubkey
    return `${pubkey.slice(0, 8)}...${pubkey.slice(-6)}`
  }

  function formatChannel(channel: string): string {
    return channel.replace(/^message server: wss?:\/\//, 'message server: ')
  }

  function recipientStatusLabel(status: string): string {
    if (status === 'seen') return 'Seen'
    if (status === 'delivered') return 'Delivered'
    if (status === 'sent') return 'Sent'
    return 'Waiting'
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="fixed inset-0 z-[70] flex items-center justify-center p-4"
  role="dialog"
  aria-modal="true"
  aria-label="Message info"
>
  <button
    class="absolute inset-0 bg-black/80 border-none cursor-default"
    onclick={onclose}
    aria-label="Close message info"
  ></button>

  <div class="relative z-10 w-full max-w-xl max-h-[90vh] bg-surface border border-surface-lighter rounded-2xl shadow-xl overflow-hidden">
    <div class="px-5 py-4 border-b border-surface-lighter flex items-center justify-between">
      <h3 class="text-lg font-semibold">Message Info</h3>
      <button
        class="btn-ghost p-2"
        onclick={onclose}
        aria-label="Close"
      >
        <span class="i-carbon-close text-xl"></span>
      </button>
    </div>

    <div class="px-5 py-4 space-y-4 overflow-y-auto max-h-[calc(90vh-4.5rem)]">
      <div class="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
        <span class="text-gray-400">Scope</span>
        <span>{messageScopeLabel}</span>
        <span class="text-gray-400">Status</span>
        <span class="capitalize">{statusLabel}</span>
        <span class="text-gray-400">Sent</span>
        <span>{formatDateTime(message.timestamp)}</span>
        {#if message.replyTo}
          <span class="text-gray-400">Reply to</span>
          <span class="font-mono text-xs">{message.replyTo}</span>
        {/if}
        {#if message.expiresAt}
          <span class="text-gray-400">Expires</span>
          <span>{formatDateTime(message.expiresAt * 1000)}</span>
        {/if}
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <p class="text-sm text-gray-400">Message ID</p>
          <button
            class="text-xs px-2 py-1 rounded-md border border-surface-lighter hover:bg-surface-light transition-colors"
            onclick={handleCopyMessageId}
          >
            {copiedMessageId ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p class="text-xs font-mono bg-surface-light px-3 py-2 rounded-lg break-all">{message.id}</p>
      </div>

      {#if deliveryChannels.length > 0 || message.isMine}
        <div class="space-y-2">
          <p class="text-sm text-gray-400">Channels</p>
          {#if deliveryChannels.length === 0}
            <p class="text-sm text-gray-500">No message server acknowledgement yet.</p>
          {:else}
            <div class="space-y-1">
              {#each deliveryChannels as channel}
                <div class="flex items-center justify-between gap-3 rounded-lg bg-surface-light px-3 py-2">
                  <span class="min-w-0 truncate text-sm" title={channel}>
                    {formatChannel(channel)}
                  </span>
                  <span class="i-carbon-checkmark text-sm text-green-400 flex-shrink-0"></span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if receiptInfo.recipientRows.length > 0}
        <div class="space-y-2">
          <p class="text-sm text-gray-400">Recipients</p>
          <div class="space-y-1">
            {#each receiptInfo.recipientRows as row}
              <div class="flex items-center justify-between gap-3 rounded-lg bg-surface-light px-3 py-2">
                <div class="min-w-0 text-sm truncate flex items-center gap-2">
                  <Avatar pubkey={row.pubkey} size={20} />
                  <Name pubkey={row.pubkey} />
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                  {#if myPubkey && row.pubkey === myPubkey}
                    <span class="text-[10px] uppercase tracking-wide text-primary">You</span>
                  {/if}
                  <span class="text-xs text-gray-400">{recipientStatusLabel(row.status)}</span>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <div class="space-y-2">
        <p class="text-sm text-gray-400">Delivered To</p>
        {#if receiptStages.deliveredBy.length === 0}
          <p class="text-sm text-gray-500">No delivered-only recipients.</p>
        {:else}
          <div class="space-y-1">
            {#each receiptStages.deliveredBy as pubkey}
              <div class="flex items-center justify-between gap-3 rounded-lg bg-surface-light px-3 py-2">
                <div class="min-w-0 text-sm truncate flex items-center gap-2">
                  <Avatar {pubkey} size={20} />
                  <Name {pubkey} />
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                  {#if myPubkey && pubkey === myPubkey}
                    <span class="text-[10px] uppercase tracking-wide text-primary">You</span>
                  {/if}
                  <span class="text-[11px] text-gray-500 font-mono">{shortPubkey(pubkey)}</span>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="space-y-2">
        <p class="text-sm text-gray-400">Seen By</p>
        {#if receiptStages.seenBy.length === 0}
          <p class="text-sm text-gray-500">No confirmed readers yet.</p>
        {:else}
          <div class="space-y-1">
            {#each receiptStages.seenBy as pubkey}
              <div class="flex items-center justify-between gap-3 rounded-lg bg-surface-light px-3 py-2">
                <div class="min-w-0 text-sm truncate flex items-center gap-2">
                  <Avatar {pubkey} size={20} />
                  <Name {pubkey} />
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                  {#if myPubkey && pubkey === myPubkey}
                    <span class="text-[10px] uppercase tracking-wide text-primary">You</span>
                  {/if}
                  <span class="text-[11px] text-gray-500 font-mono">{shortPubkey(pubkey)}</span>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      {#if receiptInfo.potentialRecipients.length > 0 && receiptInfo.recipientRows.length === 0}
        <div class="space-y-2">
          <p class="text-sm text-gray-400">Potential Recipients</p>
          <div class="space-y-1">
            {#each receiptInfo.potentialRecipients as pubkey}
              <div class="flex items-center justify-between gap-3 rounded-lg bg-surface-light/60 px-3 py-2">
                <div class="min-w-0 text-sm truncate flex items-center gap-2">
                  <Avatar {pubkey} size={20} />
                  <Name {pubkey} />
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                  {#if myPubkey && pubkey === myPubkey}
                    <span class="text-[10px] uppercase tracking-wide text-primary">You</span>
                  {/if}
                  <span class="text-[11px] text-gray-500 font-mono">{shortPubkey(pubkey)}</span>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if receiptInfo.notes.length > 0}
        <div class="rounded-lg border border-surface-lighter bg-surface-light/40 px-3 py-2 space-y-1">
          {#each receiptInfo.notes as note}
            <p class="text-xs text-gray-400">{note}</p>
          {/each}
        </div>
      {/if}

      <div class="space-y-2">
        <button
          class="text-sm px-3 py-2 rounded-lg border border-surface-lighter hover:bg-surface-light transition-colors"
          onclick={() => showRawData = !showRawData}
        >
          {showRawData ? 'Hide' : 'Show'} Raw Data
        </button>

        {#if showRawData}
          <pre class="text-xs bg-surface-light rounded-lg p-3 overflow-auto max-h-56 whitespace-pre-wrap break-all">{rawData}</pre>
        {/if}
      </div>
    </div>
  </div>
</div>
