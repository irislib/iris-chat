<script lang="ts">
  import { onMount } from 'svelte'
  import { getMediaUrl, getMimeType } from '../lib/hashtree'

  interface Props {
    src: string | null
    nhash: string | null
    filename: string
    type: 'image' | 'video'
    onclose: () => void
  }

  let { src, nhash, filename, type, onclose }: Props = $props()

  let mediaSrc = $state<string | null>(src)
  let loading = $state(!src && !!nhash)
  let error = $state<string | null>(null)

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onclose()
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      onclose()
    }
  }

  async function loadMedia() {
    if (!nhash) return

    loading = true
    error = null

    try {
      const mimeType = getMimeType(filename)
      mediaSrc = await getMediaUrl(nhash, mimeType)
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown)
    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden'

    // Load media if nhash provided
    if (nhash && !src) {
      loadMedia()
    }

    return () => {
      document.removeEventListener('keydown', handleKeydown)
      document.body.style.overflow = ''
      // Cleanup blob URL if we created one
      if (mediaSrc && nhash) {
        URL.revokeObjectURL(mediaSrc)
      }
    }
  })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  data-testid="media-modal"
  class="fixed inset-0 z-50 flex items-center justify-center"
>
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    data-testid="media-modal-backdrop"
    class="absolute inset-0 bg-black/90"
    onclick={handleBackdropClick}
  ></div>

  <!-- Content -->
  <div class="relative z-10 max-w-[90vw] max-h-[90vh] flex flex-col items-center">
    <!-- Close button -->
    <button
      class="absolute -top-10 right-0 p-2 text-white/70 hover:text-white transition-colors"
      onclick={onclose}
      aria-label="Close"
    >
      <span class="i-carbon-close text-2xl"></span>
    </button>

    <!-- Media content -->
    {#if loading}
      <div class="flex items-center justify-center w-64 h-48 bg-surface">
        <span class="i-carbon-circle-dash animate-spin text-3xl text-gray-400"></span>
      </div>
    {:else if error}
      <div class="flex flex-col items-center justify-center w-64 h-48 bg-surface text-center">
        <span class="i-carbon-warning-alt text-3xl text-red-400 mb-2"></span>
        <p class="text-sm text-red-400">Failed to load</p>
      </div>
    {:else if mediaSrc}
      {#if type === 'image'}
        <img
          src={mediaSrc}
          alt={filename}
          class="max-w-full max-h-[85vh] object-contain"
        />
      {:else if type === 'video'}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          src={mediaSrc}
          controls
          autoplay
          class="max-w-full max-h-[85vh]"
        ></video>
      {/if}
    {:else}
      <div class="flex items-center justify-center w-64 h-48 bg-surface">
        <span class="i-carbon-circle-dash animate-spin text-3xl text-gray-400"></span>
      </div>
    {/if}

    <!-- Filename -->
    <p class="mt-3 text-sm text-white/70 truncate max-w-full">{filename}</p>
  </div>
</div>
