<script lang="ts">
  import { pinnedChatIds, setChatPinned } from '../lib/chatPinStore'
  let { chatId }: { chatId: string } = $props()
  let saving = $state(false)
  let error = $state('')
  async function toggle() {
    saving = true
    error = ''
    try { await setChatPinned(chatId, !$pinnedChatIds.has(chatId)) }
    catch { error = 'Could not save pinned chat. Try again.' }
    finally { saving = false }
  }
</script>
<button class="btn-ghost w-full text-left flex items-center gap-2" onclick={toggle} disabled={saving}>
  <span class="i-carbon-pin-filled" aria-hidden="true"></span>
  {$pinnedChatIds.has(chatId) ? 'Unpin chat' : 'Pin chat'}
</button>
{#if error}<p role="alert" class="text-sm text-red-400">{error}</p>{/if}
