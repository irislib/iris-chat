<script lang="ts">
  import { onMount } from 'svelte'
  import { nativeAppPlatform, NATIVE_APP_DOWNLOAD_URL, NATIVE_APP_SUGGESTION_KEY, type NativeAppPlatform } from '../lib/nativeApp'

  let { entryHref = null, compact = false }: { entryHref?: string | null; compact?: boolean } = $props()

  let platform = $state<NativeAppPlatform | null>(null)
  let showPrompt = $state(false)
  let canOpenApp = $derived(platform === 'iPhone' || platform === 'iPad' || platform === 'Android' || platform === 'Mac')

  function remember(value: 'seen' | 'dismissed' | 'opened') {
    try { localStorage.setItem(NATIVE_APP_SUGGESTION_KEY, value) } catch { /* Storage may be unavailable. */ }
  }

  function dismiss() {
    remember('dismissed')
    showPrompt = false
  }

  function download() {
    remember('opened')
    showPrompt = false
  }

  onMount(() => {
    platform = nativeAppPlatform(navigator.userAgent, navigator.maxTouchPoints)
    if (!platform) return
    if (entryHref) { remember('seen'); return }
    if (window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone) return
    if (compact) return
    try { if (localStorage.getItem(NATIVE_APP_SUGGESTION_KEY)) return } catch { /* Keep onboarding usable. */ }
    showPrompt = true
    remember('seen')
  })
</script>

{#if platform && (entryHref || (!compact && showPrompt))}
  <aside aria-label="Iris app" class="flex items-center gap-3 text-sm shrink-0 {compact ? 'w-full px-4 py-2 bg-surface' : 'w-full max-w-md mt-4 px-2'}">
    <span class="i-carbon-download text-primary text-xl shrink-0" aria-hidden="true"></span>
    {#if entryHref && canOpenApp}
      <div class="min-w-0 flex-1 py-1">
        <div class="flex items-center flex-wrap gap-x-5 gap-y-1">
          <a href={entryHref} class="inline-flex items-center min-h-11 text-primary font-medium hover:underline">Open in app</a>
          <a href={NATIVE_APP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"
            class="inline-flex items-center min-h-11 text-primary hover:underline" onclick={download}>Get Iris for {platform}</a>
        </div>
        <p class="text-xs text-muted">After installing, return here to open this chat.</p>
      </div>
    {:else}
      <a href={NATIVE_APP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"
        class="flex-1 py-3 text-primary font-medium hover:underline" onclick={download}>
        Get Iris for {platform}
      </a>
      {#if !entryHref}
        <button aria-label="Dismiss app suggestion" class="w-11 h-11 rounded-full text-muted hover:bg-surface flex items-center justify-center shrink-0" onclick={dismiss}>
          <span class="i-carbon-close text-xl" aria-hidden="true"></span>
        </button>
      {/if}
    {/if}
  </aside>
{/if}
