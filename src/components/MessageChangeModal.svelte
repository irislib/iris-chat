<script lang="ts">
  import { onMount } from 'svelte'
  import type { ChatMessage } from '../lib/chat'
  let { message, mode, onedit, ondeleteeveryone, onclose }: {
    message: ChatMessage
    mode: 'edit' | 'history' | 'delete'
    onedit?: (messageId: string, content: string) => Promise<void>
    ondeleteeveryone?: (messageId: string) => Promise<void>
    onclose: () => void
  } = $props()
  let text = $state('')
  let input = $state<HTMLTextAreaElement>()
  onMount(() => { text = message.content; input?.focus() })
  let busy = $state(false)
  let error = $state('')
  const title = $derived(mode === 'edit' ? 'Edit message' : mode === 'history' ? 'Edit history' : 'Delete for everyone?')
  async function save() {
    busy = true
    error = ''
    try {
      if (mode === 'edit') await onedit?.(message.id, text)
      else await ondeleteeveryone?.(message.id)
      onclose()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not update this message. Try again.'
    } finally { busy = false }
  }
</script>

<svelte:window onkeydown={event => { if (event.key === 'Escape' && !busy) onclose() }} />
<div class="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
  <button class="absolute inset-0 bg-black/70 cursor-default" onclick={() => !busy && onclose()} aria-label="Close" tabindex="-1"></button>
  <div class="relative w-full max-w-lg max-h-[85vh] overflow-y-auto bg-surface border border-surface-lighter rounded-2xl p-5 shadow-xl">
    <div class="flex items-center justify-between gap-4 mb-4">
      <h2 class="font-semibold text-lg">{title}</h2>
      <button class="btn-ghost p-1" onclick={onclose} disabled={busy} aria-label="Close dialog"><span class="i-carbon-close text-xl"></span></button>
    </div>
    {#if mode === 'history'}
      <ol class="space-y-4">
        {#each [...(message.editHistory ?? [])].reverse() as version, index (version.id)}
          <li class="border-l-2 border-surface-lighter pl-3">
            <div class="flex flex-wrap gap-x-2 text-xs text-gray-500 mb-1">
              <span>{index === 0 ? 'Current' : version.id === message.id ? 'Original' : 'Edited'}</span>
              <time datetime={new Date(version.timestamp).toISOString()}>{new Date(version.timestamp).toLocaleString()}</time>
            </div>
            <p class="text-sm whitespace-pre-wrap break-words">{version.content}</p>
          </li>
        {/each}
      </ol>
    {:else}
      <form onsubmit={event => { event.preventDefault(); void save() }}>
        {#if mode === 'edit'}
          <label for="message-edit-text" class="sr-only">Message</label>
          <textarea bind:this={input} id="message-edit-text" class="w-full min-h-32 rounded-xl border border-surface-lighter bg-surface-light p-3 text-sm resize-y" bind:value={text} disabled={busy}></textarea>
          <p class="text-xs text-gray-500 mt-2">Previous versions stay in edit history.</p>
        {:else}
          <p class="text-sm text-gray-400">Others may keep messages if they have turned off deletion.</p>
        {/if}
        {#if error}<p class="text-sm text-red-400 mt-3" role="alert">{error}</p>{/if}
        <div class="flex justify-end gap-2 mt-5">
          <button type="button" class="btn-ghost" onclick={onclose} disabled={busy}>Cancel</button>
          <button type="submit" class="btn-primary" disabled={busy || mode === 'edit' && (!text.trim() || text === message.content)}>{busy ? 'Saving…' : mode === 'edit' ? 'Save' : 'Delete for everyone'}</button>
        </div>
      </form>
    {/if}
  </div>
</div>
