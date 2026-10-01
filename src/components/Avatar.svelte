<script lang="ts">
  import { minidenticon } from 'minidenticons'
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'
  import { resolvePictureUrl } from '../lib/profilePicture'
  import SocialDistanceBadge from '@iris/svelte-ui/SocialDistanceBadge.svelte'
  import { identity } from '../lib/identity'
  import { following } from '../lib/following'
  import { contactMemory } from '../lib/contactMemory'
  import { peopleGraph, getPeopleGraphSignals } from '../lib/peopleGraph'

  interface Props {
    pubkey: string
    size?: number
    loadProfile?: boolean
    showBadge?: boolean
  }

  let { pubkey, size = 32, loadProfile = true, showBadge = true }: Props = $props()

  let profileStore = $derived(pubkey ? createProfileStore(pubkey, loadProfile) : undefined)
  let profile = $derived(profileStore ? $profileStore : undefined)
  let name = $derived.by(() => { $contactMemory; return contactMemory.get($identity?.pubkey ?? '', pubkey)?.nickname || contactMemory.get($identity?.pubkey ?? '', pubkey)?.accepted_name || getProfileName(profile) || getAnimalName(pubkey) })
  let signals = $derived.by(() => { $peopleGraph.version; return getPeopleGraphSignals(pubkey) })
  let distance = $derived(pubkey === $identity?.pubkey ? 0 : $following.has(pubkey) ? 1 : signals.hasPublicPath ? signals.followDistance : null)

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

<span class="relative inline-flex shrink-0" style:width="{size}px" style:height="{size}px">
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
{#if $identity && showBadge}
  <span class="absolute -right-1 -top-1 leading-none">
    <SocialDistanceBadge {distance} followedByFriends={signals.friendsFollowing}
      muted={signals.mutedByYou} overmuted={signals.overmuted} size={size < 40 ? 12 : 16} />
  </span>
{/if}
</span>
