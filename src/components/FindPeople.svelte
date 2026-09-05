<script lang="ts">
  import { untrack } from 'svelte'
  import { nip19 } from 'nostr-tools'
  import { following } from '../lib/following'
  import { identity } from '../lib/identity'
  import { messageRequests } from '../lib/messageRequests'
  import { createProfileStore, getProfileName, type Profile } from '../lib/profile'
  import { createRuntimeMessagingPeopleStore } from '../lib/messagingPeopleRuntime'
  import { MAX_MESSAGING_PEOPLE } from '../lib/messagingPeople'
  import { startChatWithPerson, type ChatSession } from '../lib/chat'
  import { getErrorMessage } from '../lib/utils'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'

  let { onjoin }: { onjoin: (event: CustomEvent<{ chat: ChatSession }>) => void } = $props()
  let query = $state('')
  let error = $state('')
  let opening = $state(false)
  let profiles = $state(new Map<string, Profile | undefined>())
  let exactKey = $derived.by(() => {
    const value = query.trim().replace(/^nostr:/i, '')
    if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
    try {
      const decoded = nip19.decode(value)
      return decoded.type === 'npub' ? decoded.data : decoded.type === 'nprofile' ? decoded.data.pubkey : null
    } catch { return null }
  })
  let candidates = $derived([...new Set([...(exactKey ? [exactKey] : []), ...$following])]
    .filter(key => key !== $identity?.pubkey && !$messageRequests.rejectedChats[key])
    .slice(0, MAX_MESSAGING_PEOPLE))
  let capabilityStore = $derived(createRuntimeMessagingPeopleStore(candidates))
  let eligibleKeys = $derived([...$capabilityStore.events.keys()].join(','))
  $effect(() => {
    const keys = eligibleKeys ? eligibleKeys.split(',') : []
    profiles = new Map()
    const stops = keys.map(key => createProfileStore(key).subscribe(profile => {
      untrack(() => { profiles = new Map(profiles).set(key, profile) })
    }))
    return () => { for (const stop of stops) stop() }
  })
  let results = $derived.by(() => {
    const text = query.trim().toLowerCase()
    return [...$capabilityStore.events.keys()].filter(key => {
      if (exactKey) return key === exactKey
      if (!text) return true
      const profile = profiles.get(key)
      return [profile?.name, profile?.display_name, profile?.nip05].some(value => value?.toLowerCase().includes(text))
    }).sort((a, b) => (getProfileName(profiles.get(a)) || a).localeCompare(getProfileName(profiles.get(b)) || b)).slice(0, 50)
  })
  async function openPerson(key: string) {
    const support = $capabilityStore.events.get(key)
    if (!support || opening) return
    opening = true
    error = ''
    try {
      const chat = await startChatWithPerson(key, support)
      onjoin(new CustomEvent('join', { detail: { chat } }))
    } catch (cause) {
      error = getErrorMessage(cause, 'Couldn’t start chat')
    } finally { opening = false }
  }
</script>

<section class="w-full max-w-md p-6 bg-surface rounded-2xl shadow-xl overflow-hidden" aria-label="Find people">
  <h2 class="text-2xl font-bold text-white mb-4 text-center">Find people</h2>
  <input class="input-field" aria-label="Search people" placeholder="Search friends or paste a user ID" bind:value={query} />
  <div class="mt-3 max-h-64 overflow-y-auto" aria-live="polite">
    {#each results as key (key)}
      <button class="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-surface-light text-left" disabled={opening} onclick={() => openPerson(key)}>
        <Avatar pubkey={key} size={40} />
        <Name pubkey={key} />
      </button>
    {:else}
      <p class="text-gray-400 text-sm py-3">{$capabilityStore.loading ? 'Finding people…' : 'No people found'}</p>
    {/each}
  </div>
  {#if error}<p role="alert" class="text-red-400 text-sm mt-3">{error}</p>{/if}
</section>
