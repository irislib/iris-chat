<script lang="ts">
  import { onMount } from 'svelte'
  import {
    getMediaUrl,
    downloadFile,
    isImageFile,
    isVideoFile,
    isAudioFile,
    getMimeType,
  } from '../lib/hashtree'
  import { openMediaModal, openMediaModalWithNhash } from '../lib/mediaModal'

  interface Props {
    nhash: string
    filename: string
    isMine?: boolean
  }

  let { nhash, filename, isMine = false }: Props = $props()

  let mediaUrl = $state<string | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let userRequested = $state(false)

  const isImage = $derived(isImageFile(filename))
  const isVideo = $derived(isVideoFile(filename))
  const isAudio = $derived(isAudioFile(filename))
  const isMedia = $derived(isImage || isVideo || isAudio)
  const mimeType = $derived(getMimeType(filename))

  // Only auto-load images, not videos/audio (they can be large)
  const shouldAutoLoad = $derived(isImage)

  onMount(() => {
    if (shouldAutoLoad) {
      loadMedia()
    }
    return () => {
      if (mediaUrl) {
        URL.revokeObjectURL(mediaUrl)
      }
    }
  })

  async function loadMedia() {
    if (!isMedia) return

    loading = true
    error = null

    try {
      mediaUrl = await getMediaUrl(nhash, mimeType)
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load'
    } finally {
      loading = false
    }
  }

  function handleLoadClick() {
    userRequested = true
    loadMedia()
  }

  async function handleDownload() {
    try {
      const data = await downloadFile(nhash)
      // Create a new ArrayBuffer to avoid SharedArrayBuffer issues
      const buffer = new ArrayBuffer(data.length)
      new Uint8Array(buffer).set(data)
      const blob = new Blob([buffer], { type: mimeType })
      const url = URL.createObjectURL(blob)

      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()

      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('Download failed:', e)
    }
  }

  function handleImageClick() {
    openMediaModal(mediaUrl, filename, 'image')
  }

  function handleVideoClick() {
    // Open modal and let it load the video
    openMediaModalWithNhash(nhash, filename, 'video')
  }
</script>

<div class="file-attachment mt-2">
  {#if loading && isAudio}
    <!-- Audio loading - maintain button size -->
    <div class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm {isMine ? 'bg-white/20' : 'bg-surface-light'}">
      <span class="i-carbon-circle-dash animate-spin text-lg {isMine ? 'text-white/70' : 'text-gray-400'}"></span>
      <span class="truncate max-w-48">{filename}</span>
    </div>
  {:else if loading}
    <div class="flex items-center gap-2 text-gray-400 text-sm">
      <span class="i-carbon-circle-dash animate-spin"></span>
      Loading {filename}...
    </div>
  {:else if error && isImage}
    <!-- Image error - click to open modal with error -->
    <button
      class="flex items-center gap-2 px-3 py-2 bg-surface-light rounded-full hover:bg-surface-lighter transition-colors text-sm text-red-400"
      onclick={handleImageClick}
    >
      <span class="i-carbon-warning-alt"></span>
      <span class="truncate max-w-48">{filename} - failed to load</span>
    </button>
  {:else if error}
    <button
      class="flex items-center gap-2 px-3 py-2 bg-surface-light rounded-full hover:bg-surface-lighter transition-colors text-sm text-red-400"
      onclick={handleLoadClick}
    >
      <span class="i-carbon-warning-alt"></span>
      <span class="truncate max-w-48">Failed to load - tap to retry</span>
    </button>
  {:else if isImage && mediaUrl}
    <button
      class="block p-0 border-0 bg-transparent cursor-pointer"
      onclick={handleImageClick}
      aria-label="Open {filename} in new tab"
    >
      <img
        src={mediaUrl}
        alt={filename}
        class="max-w-full max-h-64 rounded-lg"
      />
    </button>
  {:else if isAudio && mediaUrl}
    <div class="rounded-lg overflow-hidden p-2 {isMine ? 'bg-primary' : 'bg-surface-light'}">
      <audio
        src={mediaUrl}
        controls
        class="w-full max-w-xs block"
      ></audio>
    </div>
  {:else if isVideo}
    <!-- Video placeholder - click to open in modal -->
    <button
      class="relative flex items-center justify-center w-48 h-32 rounded-lg transition-colors {isMine ? 'bg-primary hover:bg-primary/80' : 'bg-surface-light hover:bg-surface-lighter'}"
      onclick={handleVideoClick}
      aria-label="Play video {filename}"
    >
      <div class="absolute inset-0 flex items-center justify-center">
        <span class="i-carbon-play-filled text-4xl {isMine ? 'text-white/70' : 'text-gray-400'}"></span>
      </div>
      <span class="absolute bottom-2 left-2 right-2 text-xs truncate {isMine ? 'text-white/70' : 'text-gray-400'}">{filename}</span>
    </button>
  {:else if isAudio}
    <!-- Audio placeholder - click to load -->
    <button
      class="flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-sm {isMine ? 'bg-white/20 hover:bg-white/30' : 'bg-surface-light hover:bg-surface-lighter'}"
      onclick={handleLoadClick}
      aria-label="Load audio {filename}"
    >
      <span class="i-carbon-play-filled text-lg {isMine ? 'text-white/70' : 'text-gray-400'}"></span>
      <span class="truncate max-w-48">{filename}</span>
    </button>
  {:else}
    <!-- Generic file download -->
    <button
      class="flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-sm {isMine ? 'bg-primary hover:bg-primary/80' : 'bg-surface-light hover:bg-surface-lighter'}"
      onclick={handleDownload}
    >
      <span class="i-carbon-document-download text-lg {isMine ? 'text-white/70' : ''}"></span>
      <span class="truncate max-w-48">{filename}</span>
    </button>
  {/if}
</div>

