<script lang="ts">
  import { parseFileLink, getMediaUrl, isImageFile } from '../lib/hashtree'

  interface Props {
    picture?: string
    size?: number
  }

  let { picture, size = 48 }: Props = $props()

  let imageUrl = $state<string | null>(null)

  // Resolve hashtree picture URIs to blob URLs
  $effect(() => {
    imageUrl = null
    if (!picture) return

    // nhash://nhash1.../filename format
    const stripped = picture.replace(/^nhash:\/\//, '')
    const parsed = parseFileLink(stripped)
    if (parsed && isImageFile(parsed.filename)) {
      getMediaUrl(parsed.nhash, 'image/*').then(url => {
        imageUrl = url
      }).catch(() => {})
    }
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
