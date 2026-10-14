<script lang="ts">
  import ContactMemoryPanel from '@iris/svelte-ui/ContactMemoryPanel.svelte'
  import { identity } from '../lib/identity'
  import { contactMemory, favoriteContact, approveContactName } from '../lib/contactMemory'
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { pendingContactName } from '@iris/svelte-ui/contactMemory'
  import { get } from 'svelte/store'
  import { privateStateVersion } from '../lib/privateStateStore'
  import { isPrivatelyBlocked } from '../lib/privateStateStore'
  import { setPrivateBlock } from '../lib/privateStateControl'
  import PrivateContactDetails from './PrivateContactDetails.svelte'

  let { pubkey, compact = false }: { pubkey: string; compact?: boolean } = $props()
  let profileStore = $derived(createProfileStore(pubkey))
  let currentName = $derived(getProfileName($profileStore) ?? null)
  let memory = $derived.by(() => { $contactMemory; return contactMemory.get($identity?.pubkey ?? '', pubkey) })
  let pending = $derived(memory ? pendingContactName(memory, currentName) : null)
  let error = $state('')
  let blocked = $state(false)
  let savingBlock = $state(false)
  $effect(() => {
    $privateStateVersion
    const account = $identity?.pubkey, contact = pubkey
    let active = true
    if (account) void isPrivatelyBlocked(account, contact).then(value => { if (active) blocked = value })
    return () => { active = false }
  })
  async function toggleBlock() {
    const account = get(identity)?.pubkey
    if (!account || savingBlock) return
    savingBlock = true; error = ''
    try { await setPrivateBlock(account, pubkey, !blocked); blocked = await isPrivatelyBlocked(account, pubkey) }
    catch { error = 'Could not save. Try again.' }
    finally { savingBlock = false }
  }
  async function approve(expected: string) {
    error = ''
    try { await approveContactName($identity?.pubkey ?? '', pubkey, expected) }
    catch { error = 'Could not save. Try again.' }
  }
  async function favorite(value: boolean) {
    error = ''
    try { await favoriteContact($identity!.pubkey, pubkey, value) }
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
      onFavoriteChange={value => { void favorite(value) }}
      onApproveName={expected => { void approve(expected) }} />
    {#if memory?.first_seen_name && memory.first_seen_name !== memory.accepted_name}
      <p class="text-xs text-gray-400 mt-3">First known as {memory.first_seen_name}</p>
    {/if}
    {#key `${$identity.pubkey}:${pubkey}`}
      <PrivateContactDetails {pubkey} nickname={memory?.nickname} note={memory?.note} />
    {/key}
    <button class="btn-secondary mt-3 text-sm" disabled={savingBlock} onclick={toggleBlock}>{blocked ? "Unblock" : "Block"}</button>
    {#if error}<p role="alert">{error}</p>{/if}
  {/if}
{/if}
