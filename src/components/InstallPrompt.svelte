<script lang="ts">
  import { onMount } from 'svelte'
  import { nativeAppPlatform, NATIVE_APP_DOWNLOAD_URL, NATIVE_APP_SUGGESTION_KEY, type NativeAppPlatform } from '../lib/nativeApp'

  let { entryHref = null, welcome = false, excluded = false }: {
    entryHref?: string | null
    welcome?: boolean
    excluded?: boolean
  } = $props()

  let dialog = $state<HTMLDialogElement>()
  let platform = $state<NativeAppPlatform | null>(null)
  let showPrompt = $state(false)
  let downloadStarted = $state(false)
  let canOpenApp = $derived(platform === 'iPhone' || platform === 'iPad' || platform === 'Android' || platform === 'Mac')

  function remember(value: 'seen' | 'dismissed' | 'opened') {
    try { localStorage.setItem(NATIVE_APP_SUGGESTION_KEY, value) } catch { /* Storage may be unavailable. */ }
  }

  function dismiss() {
    remember('dismissed')
    showPrompt = false
    dialog?.close()
  }

  function download() {
    remember('opened')
    downloadStarted = true
  }

  onMount(() => {
    platform = nativeAppPlatform(navigator.userAgent, navigator.maxTouchPoints)
    if (!platform || excluded || (!welcome && !entryHref)) return
    if (window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone) return
    try {
      const choice = localStorage.getItem(NATIVE_APP_SUGGESTION_KEY)
      if (choice === 'dismissed' || (choice === 'opened' && !entryHref)) return
      downloadStarted = choice === 'opened'
    } catch { /* Keep onboarding usable. */ }
    showPrompt = true
    if (!downloadStarted) remember('seen')
  })

  $effect(() => {
    if (excluded && showPrompt) {
      showPrompt = false
      dialog?.close()
    } else if (showPrompt && dialog && !dialog.open) {
      dialog.showModal()
      dialog.querySelector<HTMLAnchorElement>('[data-download]')?.focus()
    }
  })
</script>

{#if platform}
  <dialog bind:this={dialog} aria-labelledby="native-download-title" class="download-dialog" oncancel={dismiss}>
    <button aria-label="Close download suggestion" class="close-download" onclick={dismiss}>
      <span class="i-carbon-close text-2xl" aria-hidden="true"></span>
    </button>
    <div class="download-content">
      <img src={`${import.meta.env.BASE_URL}iris-logo.png`} alt="" class="app-logo" draggable="false" />
      <h1 id="native-download-title">Download Iris</h1>
      <p class="download-description">Private messages and calls on {platform}.</p>
      <div class="download-actions">
        <a href={NATIVE_APP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"
          class="download-button" data-download onclick={download}>
          Download for {platform}
        </a>
        <button class="browser-button" onclick={dismiss}>Continue in browser</button>
      </div>
      {#if downloadStarted && entryHref && canOpenApp}
        <div class="installed-action">
          <p>After installing, return here to open this chat.</p>
          <a href={entryHref}>Open Iris</a>
        </div>
      {/if}
    </div>
  </dialog>
{/if}

<style>
  .download-dialog {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    height: 100dvh;
    max-height: 100dvh;
    margin: 0;
    padding: 0;
    border: 0;
    background: rgb(var(--color-panel));
    color: rgb(var(--color-text));
  }
  .download-dialog[open] { display: flex; }
  .download-dialog::backdrop { background: rgb(0 0 0 / 0.7); backdrop-filter: blur(6px); }
  .close-download {
    position: absolute;
    top: max(16px, env(safe-area-inset-top));
    right: max(16px, env(safe-area-inset-right));
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    color: rgb(var(--color-muted));
  }
  .close-download:hover { background: rgb(var(--color-surface)); }
  .download-content {
    width: 100%;
    max-width: 400px;
    margin: auto;
    padding: 80px 28px;
    text-align: center;
  }
  .app-logo { display: block; width: 88px; height: 88px; margin: 0 auto 28px; }
  h1 { margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.035em; line-height: 1.2; }
  .download-description { margin: 12px 0 32px; color: rgb(var(--color-muted)); font-size: 16px; }
  .download-actions { display: flex; flex-direction: column; gap: 12px; }
  .download-button, .browser-button {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 52px;
    padding: 12px 20px;
    border-radius: 14px;
    font-size: 16px;
    font-weight: 600;
  }
  .download-button { background: rgb(var(--color-primary)); color: white; }
  .download-button:hover { background: rgb(var(--color-primary-dark)); }
  .browser-button { color: rgb(var(--color-muted)); }
  .browser-button:hover { background: rgb(var(--color-surface)); color: rgb(var(--color-text)); }
  .installed-action { margin-top: 24px; font-size: 14px; }
  .installed-action p { margin: 0 0 8px; color: rgb(var(--color-muted)); }
  .installed-action a { display: inline-flex; align-items: center; min-height: 44px; color: rgb(var(--color-primary)); font-weight: 600; }
  :is(button, a):focus-visible { outline: 2px solid rgb(var(--color-primary)); outline-offset: 4px; }
  @media (min-width: 640px) {
    .download-dialog { width: 440px; max-width: calc(100vw - 48px); height: fit-content; max-height: calc(100dvh - 48px); margin: auto; border-radius: 24px; }
    .download-content { padding: 64px 28px 40px; }
  }
</style>
