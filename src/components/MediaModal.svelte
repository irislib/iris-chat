<script lang="ts">
  import { onMount } from 'svelte'

  interface Props {
    src: string | null
    filename: string
    type: 'image' | 'video'
    onclose: () => void
  }

  let { src, filename, type, onclose }: Props = $props()

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

  onMount(() => {
    document.addEventListener('keydown', handleKeydown)
    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeydown)
      document.body.style.overflow = ''
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
    {#if src}
      {#if type === 'image'}
        <img
          {src}
          alt={filename}
          class="max-w-full max-h-[85vh] object-contain"
        />
      {:else if type === 'video'}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          {src}
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
