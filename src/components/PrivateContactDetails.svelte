<script lang="ts">
  import { editPrivateContact, privateContactsStatus, resumePrivateContactSync } from '../lib/privateContactSync'
  let { pubkey, nickname = null, note = null }: { pubkey: string; nickname?: string | null; note?: string | null } = $props()
  let nameInput = $state(''), noteInput = $state(''), nameDirty = $state(false), noteDirty = $state(false)
  let context = $state(''), saving = $state(false), error = $state('')
  $effect(() => {
    if (context !== pubkey) { context = pubkey; nameDirty = false; noteDirty = false; error = '' }
    if (!nameDirty) nameInput = nickname ?? ''
    if (!noteDirty) noteInput = note ?? ''
  })
  async function save() {
    saving = true; error = ''
    try {
      const name = nameInput.trim().replace(/\s+/g, ' '), text = noteInput.replace(/\r\n?/g, '\n').trim()
      if ([...name].length > 80 || [...text].length > 240) throw new Error('Use up to 80 characters for a nickname and 240 for a note.')
      await editPrivateContact(pubkey, { ...(nameDirty ? { nickname: name || null } : {}), ...(noteDirty ? { note: text || null } : {}) })
      nameDirty = false; noteDirty = false
    } catch (reason) { error = reason instanceof Error ? reason.message : 'Could not save. Try again.' }
    finally { saving = false }
  }
</script>

<details class="mt-3 text-sm" data-testid="private-contact-details">
  <summary class="cursor-pointer text-gray-400">Private details</summary>
  <form class="mt-3 flex flex-col gap-3 text-left" onsubmit={event => { event.preventDefault(); void save() }}>
    <label class="flex flex-col gap-1">Nickname
      <input class="input-field" value={nameInput} disabled={saving} oninput={event => { nameDirty = true; nameInput = event.currentTarget.value }} autocomplete="off" />
    </label>
    <label class="flex flex-col gap-1">Note
      <textarea class="input-field !rounded-2xl min-h-20" value={noteInput} disabled={saving} oninput={event => { noteDirty = true; noteInput = event.currentTarget.value }} rows="3"></textarea>
    </label>
    <div class="flex items-center gap-3">
      <button type="submit" class="btn-secondary" disabled={saving || (!nameDirty && !noteDirty)}>{saving ? 'Saving…' : 'Save'}</button>
      {#if ['error', 'pending', 'queueing'].includes($privateContactsStatus)}<span class="text-xs text-gray-400">Waiting to sync</span>{/if}
      {#if $privateContactsStatus === 'error'}<button type="button" class="text-sm underline" onclick={resumePrivateContactSync}>Retry sync</button>{/if}
    </div>
    {#if error}<p role="alert" class="text-red-400">{error}</p>{/if}
  </form>
</details>
