<script lang="ts">
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'

  interface Props {
    pubkey: string
  }

  let { pubkey }: Props = $props()

  let profileStore = $derived(pubkey ? createProfileStore(pubkey) : undefined)
  let profile = $derived(profileStore ? $profileStore : undefined)
  let profileName = $derived(getProfileName(profile))
  let animalName = $derived(getAnimalName(pubkey))
</script>

{#if profileName}
  <span class="truncate">{profileName}</span>
{:else}
  <span class="truncate italic opacity-70">{animalName}</span>
{/if}
