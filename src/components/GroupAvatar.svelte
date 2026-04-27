<script lang="ts">
  import { resolvePictureUrl } from '../lib/profilePicture'

  interface Props {
    picture?: string
    size?: number
  }

  let { picture, size = 48 }: Props = $props()

  let imageUrl = $state<string | null>(null)

  $effect(() => {
    if (!picture) {
      imageUrl = null
      return
    }

    let cancelled = false
    resolvePictureUrl(picture, { width: size, height: size, square: true })
      .then(url => {
        if (cancelled) return
        if (url !== imageUrl) imageUrl = url
      })
      .catch(() => {})

    return () => { cancelled = true }
  })
</script>

<div
  class="rounded-full bg-surface-light flex items-center justify-center flex-shrink-0 overflow-hidden"
  style="width: {size}px; height: {size}px"
>
  {#if imageUrl}
    <img src={imageUrl} alt="Group" class="w-full h-full object-cover" />
  {:else}
    <span class="i-carbon-group text-gray-400" style="font-size: {Math.round(size * 0.45)}px"></span>
  {/if}
</div>
