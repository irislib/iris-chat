<script lang="ts">
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'
  import { identity } from '../lib/identity'
  import { contactMemory } from '../lib/contactMemory'

  interface Props {
    pubkey: string
    loadProfile?: boolean
  }

  let { pubkey, loadProfile = true }: Props = $props()

  let profileStore = $derived(pubkey ? createProfileStore(pubkey, loadProfile) : undefined)
  let profile = $derived(profileStore ? $profileStore : undefined)
  let profileName = $derived.by(() => {
    $contactMemory
    return contactMemory.get($identity?.pubkey ?? '', pubkey)?.accepted_name || getProfileName(profile)
  })
  let animalName = $derived(getAnimalName(pubkey))
</script>

{#if profileName}
  <span class="truncate">{profileName}</span>
{:else}
  <span class="truncate italic opacity-70">{animalName}</span>
{/if}
