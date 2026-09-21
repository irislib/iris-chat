<script lang="ts">
  import { onMount } from 'svelte'
  import { following } from '../lib/following'
  import { identity } from '../lib/identity'
  import { messageRequests } from '../lib/messageRequests'
  import { getProfileName } from '../lib/profile'
  import { createRuntimeMessagingPeopleStore } from '../lib/messagingPeopleRuntime'
  import { MAX_MESSAGING_PEOPLE } from '../lib/messagingPeople'
  import { createRuntimePeopleProfilesStore } from '../lib/peopleProfilesRuntime'
  import { mergePeopleProfiles, peopleSearchKey, peopleSearchScore } from '../lib/peopleSearch'
  import { peopleGraph, initPeopleGraph, getPeopleGraphCandidates, getPeopleGraphSignals } from '../lib/peopleGraph'
  import { startChatWithPerson, type ChatSession } from '../lib/chat'
  import { getErrorMessage } from '../lib/utils'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'

  let { onjoin }: { onjoin: (event: CustomEvent<{ chat: ChatSession }>) => void } = $props()
  let query = $state('')
  let error = $state('')
  let opening = $state(false)
  onMount(initPeopleGraph)
  let exactKey = $derived(peopleSearchKey(query))
  let socialKeys = $derived.by(() => {
    $peopleGraph.version
    return [...new Set([...(exactKey ? [exactKey] : []), ...$following, ...getPeopleGraphCandidates(MAX_MESSAGING_PEOPLE)])]
      .filter(key => key !== $identity?.pubkey && !$messageRequests.rejectedChats[key])
      .slice(0, MAX_MESSAGING_PEOPLE).join(',')
  })
  let localProfiles = $derived(createRuntimePeopleProfilesStore({ owners: socialKeys ? socialKeys.split(',') : [] }))
  let remoteProfiles = $derived(createRuntimePeopleProfilesStore({ query: exactKey ? '' : query }))
  let profiles = $derived(mergePeopleProfiles($remoteProfiles.profiles, $localProfiles.profiles))
  let candidateKeys = $derived.by(() => {
    $peopleGraph.version
    const keys = exactKey ? [exactKey] : [...new Set([...socialKeys.split(',').filter(Boolean), ...profiles.keys()])]
    return keys.filter(key => key !== $identity?.pubkey && !$messageRequests.rejectedChats[key] &&
      (exactKey || !getPeopleGraphSignals(key).overmuted))
      .map(key => ({ key, score: exactKey ? 0 : peopleSearchScore(profiles.get(key), query, getPeopleGraphSignals(key)) }))
      .filter(item => item.score > -Infinity)
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
      .slice(0, MAX_MESSAGING_PEOPLE).map(item => item.key).sort().join(',')
  })
  let capabilityStore = $derived(createRuntimeMessagingPeopleStore(candidateKeys ? candidateKeys.split(',') : []))
  let loading = $derived($localProfiles.loading || $remoteProfiles.loading || $capabilityStore.loading)
  let results = $derived.by(() => {
    $peopleGraph.version
    return [...$capabilityStore.events.keys()]
      .map(key => ({ key, score: exactKey ? 0 : peopleSearchScore(profiles.get(key), query, getPeopleGraphSignals(key)) }))
      .sort((a, b) => b.score - a.score ||
        getPeopleGraphSignals(a.key).followDistance - getPeopleGraphSignals(b.key).followDistance ||
        (getProfileName(profiles.get(a.key)) || a.key).localeCompare(getProfileName(profiles.get(b.key)) || b.key))
      .slice(0, 50).map(item => item.key)
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
  <input class="input-field" aria-label="Search people" placeholder="Search people or paste a user ID" bind:value={query} />
  <div class="mt-3 max-h-64 overflow-y-auto" aria-live="polite">
    {#each results as key (key)}
      <button class="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-surface-light text-left" disabled={opening} onclick={() => openPerson(key)}>
        <Avatar pubkey={key} size={40} loadProfile={false} />
        <Name pubkey={key} loadProfile={false} />
      </button>
    {:else}
      <p class="text-gray-400 text-sm py-3">{loading ? 'Finding people…' : $remoteProfiles.unavailable ? 'Search is unavailable. Try again.' : 'No people found'}</p>
    {/each}
  </div>
  {#if error}<p role="alert" class="text-red-400 text-sm mt-3">{error}</p>{/if}
</section>
