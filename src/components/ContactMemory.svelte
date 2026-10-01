<script lang="ts">
  import ContactMemoryPanel from '@iris/svelte-ui/ContactMemoryPanel.svelte'
  import { identity } from '../lib/identity'
  import { contactMemory, favoriteContact, approveContactName } from '../lib/contactMemory'
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { pendingContactName } from '@iris/svelte-ui/contactMemory'

  let { pubkey, compact = false }: { pubkey: string; compact?: boolean } = $props()
  let profileStore = $derived(createProfileStore(pubkey))
  let currentName = $derived(getProfileName($profileStore) ?? null)
  let memory = $derived.by(() => { $contactMemory; return contactMemory.get($identity?.pubkey ?? '', pubkey) })
  let pending = $derived(memory ? pendingContactName(memory, currentName) : null)
  let error = $state('')
  function approve(expected: string) {
    error = ''
    try { approveContactName($identity?.pubkey ?? '', pubkey, expected) }
    catch { error = 'Could not save. Try again.' }
  }
</script>

{#if $identity && $identity.pubkey !== pubkey}
  {#if compact}
    {#if pending}
      <div class="text-sm text-center py-3 break-words" data-testid="contact-name-change">
        <p>{memory?.accepted_name} now goes by <strong>{pending}</strong>.</p>
        <button class="btn-secondary mt-2 text-sm" onclick={() => pending && approve(pending)}>Use this name</button>
        {#if error}<p role="alert">{error}</p>{/if}
      </div>
    {/if}
  {:else}
    <ContactMemoryPanel {memory} {currentName}
      onFavoriteChange={favorite => favoriteContact($identity!.pubkey, pubkey, favorite)}
      onApproveName={expected => { approveContactName($identity!.pubkey, pubkey, expected) }} />
    {#if memory?.first_seen_name && memory.first_seen_name !== memory.accepted_name}
      <p class="text-xs text-gray-400 mt-3">First known as {memory.first_seen_name}</p>
    {/if}
  {/if}
{/if}
