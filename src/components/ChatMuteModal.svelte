<script lang="ts">
  import { identity } from '../lib/identity'
  import { loadMentionNotificationSettings, mentionNotificationSettings, setMentionNotifications } from '../lib/mentionNotificationSettings'
  $effect(() => { void loadMentionNotificationSettings($identity?.pubkey ?? null).catch(() => { error = 'Could not load notification settings.' }) })
  async function toggleMentions(enabled: boolean) {
    saving = true; error = ''
    try { await setMentionNotifications(chatId,enabled) } catch { error = 'Could not save. Try again.' }
    finally { saving = false }
  }
  import { CHAT_MUTE_DURATIONS, isChatMuted } from '../lib/chatMutePolicy'
  import { chatMutes, setChatMute } from '../lib/chatMuteStore'
  let { chatId, onclose }: { chatId: string; onclose: () => void } = $props()
  let saving = $state(false)
  let error = $state('')
  async function select(seconds: number | null) {
    saving = true
    try { await setChatMute(chatId, seconds); onclose() }
    catch { error = 'Could not save. Try again.'; saving = false }
  }
</script>

<svelte:window onkeydown={event => { if (event.key === 'Escape') onclose() }} />
<div class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-label="Mute notifications">
  <button class="absolute inset-0 cursor-default border-none bg-transparent" onclick={onclose} aria-label="Close mute options"></button>
  <div class="bg-surface rounded-2xl p-6 max-w-sm w-full relative z-10 max-h-full overflow-y-auto">
    <h3 class="text-lg font-semibold mb-4">Mute notifications</h3>
    {#if isChatMuted($chatMutes, chatId)}
      <p class="text-sm text-gray-400 mb-2">{$chatMutes[chatId] === 0 ? 'Muted always' : `Muted until ${new Date($chatMutes[chatId] * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`}</p>
      <button class="btn-ghost w-full text-left" disabled={saving} onclick={() => select(null)}>Unmute</button>
    {/if}
    {#each CHAT_MUTE_DURATIONS as duration}
      <button class="btn-ghost w-full text-left" disabled={saving} onclick={() => select(duration.seconds)}>{duration.label}</button>
    {/each}
    <button class="btn-ghost w-full text-left" disabled={saving} onclick={() => select(0)}>Always</button>
    {#if chatId.startsWith('group:')}
      <label class="flex items-center justify-between gap-4 mt-4 text-sm">
        Notify me when mentioned
        <input type="checkbox" style="appearance: auto; width: 1.25rem; height: 1.25rem; accent-color: rgb(var(--color-primary))" checked={$mentionNotificationSettings[chatId]?.enabled !== false} disabled={saving}
          onchange={event => toggleMentions(event.currentTarget.checked)} />
      </label>
      <p class="text-xs text-gray-400 mt-2">Muted mentions can notify while this app is open. Browser background notifications stay muted.</p>
    {/if}
    {#if error}<p role="alert" class="text-red-400 text-sm mt-2">{error}</p>{/if}
    <button class="btn-ghost mt-4 float-right" onclick={onclose}>Cancel</button>
  </div>
</div>
