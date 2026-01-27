<script lang="ts">
  import { onMount } from 'svelte'

  let showPrompt = $state(false)
  let isIOS = $state(false)
  let isAndroid = $state(false)
  let deferredPrompt = $state<BeforeInstallPromptEvent | null>(null)

  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
  }

  const DISMISS_KEY = 'pwa-install-dismissed'

  function isStandalone(): boolean {
    return window.matchMedia('(display-mode: standalone)').matches ||
           (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  }

  function isMobile(): boolean {
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
  }

  function detectPlatform() {
    const ua = navigator.userAgent
    isIOS = /iPhone|iPad|iPod/i.test(ua) && !(window as Window & { MSStream?: unknown }).MSStream
    isAndroid = /Android/i.test(ua)
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, Date.now().toString())
    showPrompt = false
  }

  async function handleInstallClick() {
    if (!deferredPrompt) return

    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice

    if (outcome === 'accepted') {
      dismiss()
    }
    deferredPrompt = null
  }

  onMount(() => {
    // Don't show if already in standalone mode
    if (isStandalone()) return

    // Don't show on desktop
    if (!isMobile()) return

    // Check if previously dismissed (within last 7 days)
    const dismissedAt = localStorage.getItem(DISMISS_KEY)
    if (dismissedAt) {
      const daysSinceDismiss = (Date.now() - parseInt(dismissedAt)) / (1000 * 60 * 60 * 24)
      if (daysSinceDismiss < 7) return
    }

    detectPlatform()

    // On iOS, just show the prompt with instructions
    if (isIOS) {
      // Only show on Safari (other iOS browsers can't install PWAs)
      const isSafari = /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS|OPiOS/i.test(navigator.userAgent)
      if (isSafari) {
        showPrompt = true
      }
      return
    }

    // On Android, listen for beforeinstallprompt
    if (isAndroid) {
      const handler = (e: Event) => {
        e.preventDefault()
        deferredPrompt = e as BeforeInstallPromptEvent
        showPrompt = true
      }
      window.addEventListener('beforeinstallprompt', handler)

      // Also show manual instructions if no prompt after delay
      const timeout = setTimeout(() => {
        if (!deferredPrompt) {
          showPrompt = true
        }
      }, 2000)

      return () => {
        window.removeEventListener('beforeinstallprompt', handler)
        clearTimeout(timeout)
      }
    }
  })
</script>

{#if showPrompt}
  <div class="fixed inset-0 z-[100] bg-[#121212] flex flex-col overflow-y-auto">
    <!-- Header -->
    <div class="flex justify-end p-4">
      <button
        class="text-gray-400 hover:text-white p-2"
        onclick={dismiss}
        aria-label="Close"
      >
        <span class="i-carbon-close text-2xl"></span>
      </button>
    </div>

    <!-- Content -->
    <div class="flex-1 flex flex-col items-center justify-center px-6 text-center">
      <img src="/iris-logo.png" alt="Iris" class="w-20 h-20 mb-6" draggable="false" />

      <h1 class="text-2xl font-bold mb-2">
        Install <span class="text-primary">iris</span> chat
      </h1>

      <p class="text-gray-400 mb-8 max-w-xs">
        Add to your home screen for push notifications and a better experience
      </p>

      {#if isIOS}
        <!-- iOS Instructions -->
        <div class="bg-surface rounded-2xl p-6 w-full max-w-sm">
          <div class="flex items-start gap-4 mb-4">
            <div class="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
              <span class="text-primary font-bold">1</span>
            </div>
            <div class="text-left">
              <p class="text-white">Tap the share button</p>
              <p class="text-gray-500 text-sm mt-1">
                <span class="i-carbon-share text-primary"></span> at the bottom of Safari
              </p>
            </div>
          </div>

          <div class="flex items-start gap-4 mb-4">
            <div class="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
              <span class="text-primary font-bold">2</span>
            </div>
            <div class="text-left">
              <p class="text-white">Scroll down and tap</p>
              <p class="text-gray-500 text-sm mt-1">
                <span class="i-carbon-add-alt text-primary"></span> "Add to Home Screen"
              </p>
            </div>
          </div>

          <div class="flex items-start gap-4">
            <div class="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
              <span class="text-primary font-bold">3</span>
            </div>
            <div class="text-left">
              <p class="text-white">Tap "Add"</p>
              <p class="text-gray-500 text-sm mt-1">in the top right corner</p>
            </div>
          </div>
        </div>

        <p class="text-gray-500 text-xs mt-6 max-w-xs">
          Push notifications require the app to be installed on your home screen
        </p>

      {:else if isAndroid}
        <!-- Android Instructions -->
        {#if deferredPrompt}
          <!-- Native install available -->
          <button
            class="btn-primary px-8 py-4 text-lg rounded-xl mb-4"
            onclick={handleInstallClick}
          >
            <span class="i-carbon-download mr-2"></span>
            Install App
          </button>
          <p class="text-gray-500 text-sm">
            Tap to add iris chat to your home screen
          </p>
        {:else}
          <!-- Manual instructions -->
          <div class="bg-surface rounded-2xl p-6 w-full max-w-sm">
            <div class="flex items-start gap-4 mb-4">
              <div class="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                <span class="text-primary font-bold">1</span>
              </div>
              <div class="text-left">
                <p class="text-white">Tap the menu button</p>
                <p class="text-gray-500 text-sm mt-1">
                  <span class="i-carbon-overflow-menu-vertical text-primary"></span> in the top right of Chrome
                </p>
              </div>
            </div>

            <div class="flex items-start gap-4 mb-4">
              <div class="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                <span class="text-primary font-bold">2</span>
              </div>
              <div class="text-left">
                <p class="text-white">Tap "Install app"</p>
                <p class="text-gray-500 text-sm mt-1">or "Add to Home screen"</p>
              </div>
            </div>

            <div class="flex items-start gap-4">
              <div class="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                <span class="text-primary font-bold">3</span>
              </div>
              <div class="text-left">
                <p class="text-white">Confirm installation</p>
                <p class="text-gray-500 text-sm mt-1">Tap "Install" in the popup</p>
              </div>
            </div>
          </div>
        {/if}
      {/if}
    </div>

    <!-- Footer -->
    <div class="p-6 text-center">
      <button
        class="text-gray-500 hover:text-gray-300 text-sm"
        onclick={dismiss}
      >
        Maybe later
      </button>
    </div>
  </div>
{/if}
