<script lang="ts">
  /**
   * Connectivity indicator - shows relay connection status
   * Red: offline/none, Yellow: connecting, Green: connected
   */
  import { relayStore } from '../lib/relayStore'

  interface Props {
    onclick?: () => void
  }

  let { onclick }: Props = $props()

  let connectedCount = $derived($relayStore.connectedCount)
  let totalCount = $derived($relayStore.relays.size)
  let showConnectivity = $derived($relayStore.showConnectivity)
  let showOfflineOnly = $derived(!showConnectivity && connectedCount === 0)

  // Track browser online/offline status
  let isOnline = $state(typeof navigator !== 'undefined' ? navigator.onLine : true)

  $effect(() => {
    const handleOnline = () => { isOnline = true }
    const handleOffline = () => { isOnline = false }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  })

  // Color logic
  let color = $derived.by(() => {
    if (!isOnline) return '#f85149' // red when offline
    if (connectedCount === 0) return totalCount > 0 ? '#d29922' : '#f85149' // yellow if connecting
    return '#3fb950' // green - connected
  })

  let title = $derived.by(() => {
    if (!isOnline) return 'Offline'
    if (connectedCount === 0) {
      return totalCount > 0
        ? `Connecting to ${totalCount} relay${totalCount !== 1 ? 's' : ''}`
        : 'No relays configured'
    }
    return `${connectedCount}/${totalCount} relay${totalCount !== 1 ? 's' : ''} connected`
  })
</script>

{#if showOfflineOnly}
  <button
    class="flex items-center px-2 py-1 text-xs text-red-400 rounded hover:bg-surface-light transition-colors"
    {onclick}
    aria-label="Offline"
    title="Offline"
  >
    offline
  </button>
{:else}
  <button
    class="flex items-center gap-1 px-2 py-1 text-sm rounded hover:bg-surface-light transition-colors"
    {onclick}
    {title}
  >
    <span
      class="i-carbon-wifi"
      style="color: {color}"
    ></span>
    <span class="text-xs" style="color: {color}">{connectedCount}</span>
    {#if !isOnline}
      <span class="text-[10px] text-red-400">offline</span>
    {/if}
  </button>
{/if}
