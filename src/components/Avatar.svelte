<script lang="ts">
  import { minidenticon } from 'minidenticons'
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'

  interface Props {
    pubkey: string
    size?: number
  }

  let { pubkey, size = 32 }: Props = $props()

  let profileStore = $derived(pubkey ? createProfileStore(pubkey) : undefined)
  let profile = $derived(profileStore ? $profileStore : undefined)
  let name = $derived(getProfileName(profile) || getAnimalName(pubkey))

  let imgError = $state(false)
  $effect(() => {
    pubkey
    imgError = false
  })

  let identicon = $derived(minidenticon(pubkey, 90, 50))
</script>

{#if profile?.picture && !imgError}
  <img
    src={profile.picture}
    alt={name}
    title={name}
    width={size}
    height={size}
    class="rounded-full object-cover"
    onerror={() => imgError = true}
  />
{:else}
  <img
    src="data:image/svg+xml;utf8,{encodeURIComponent(identicon)}"
    alt={name}
    title={name}
    width={size}
    height={size}
    class="rounded-full"
  />
{/if}
