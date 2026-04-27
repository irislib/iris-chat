<script lang="ts">
  import { minidenticon } from 'minidenticons'
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'
  import { resolvePictureUrl } from '../lib/profilePicture'

  interface Props {
    pubkey: string
    size?: number
  }

  let { pubkey, size = 32 }: Props = $props()

  let profileStore = $derived(pubkey ? createProfileStore(pubkey) : undefined)
  let profile = $derived(profileStore ? $profileStore : undefined)
  let name = $derived(getProfileName(profile) || getAnimalName(pubkey))

  let imgError = $state(false)
  let proxiedSrc = $state<string | null>(null)

  $effect(() => {
    const pic = profile?.picture
    if (!pic) {
      proxiedSrc = null
      imgError = false
      return
    }

    let cancelled = false
    resolvePictureUrl(pic, { width: size, height: size, square: true })
      .then(url => {
        if (cancelled) return
        if (url !== proxiedSrc) proxiedSrc = url
        imgError = false
      })
      .catch(() => {})

    return () => { cancelled = true }
  })

  let identicon = $derived(minidenticon(pubkey, 90, 50))
</script>

{#if proxiedSrc && !imgError}
  <img
    src={proxiedSrc}
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
