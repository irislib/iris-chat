<script lang="ts">
  import { notificationSettings } from '../lib/notificationStore'
  import { subscribeToDMNotifications } from '../lib/notifications'

  // Reactive state from store
  let settings = $state($notificationSettings)

  // Subscribe to store changes
  $effect(() => {
    const unsubscribe = notificationSettings.subscribe((value) => {
      settings = value
    })
    return unsubscribe
  })

  let isLoading = $state(false)
  let permissionState = $state<NotificationPermission>('default')
  let hasAutoSubscribed = $state(false)

  // Check permission on mount and auto-subscribe if already granted
  $effect(() => {
    if ('Notification' in window) {
      permissionState = Notification.permission

      // Auto-subscribe if permission is already granted but not yet subscribed
      if (permissionState === 'granted' && !settings.enabled && !hasAutoSubscribed) {
        hasAutoSubscribed = true
        subscribeToDMNotifications().catch(err => {
          console.error('Failed to auto-subscribe to notifications:', err)
        })
      }
    }
  })

  // Show prompt if:
  // - Notification API is available
  // - Permission is 'default' (not granted or denied)
  // - User hasn't declined
  // - Notifications are not already enabled
  let shouldShow = $derived(
    'Notification' in window &&
    permissionState === 'default' &&
    !settings.declined &&
    !settings.enabled
  )

  async function handleEnable() {
    isLoading = true

    try {
      const result = await Notification.requestPermission()
      permissionState = result

      if (result === 'granted') {
        await subscribeToDMNotifications()
      }
    } catch (error) {
      console.error('Failed to enable notifications:', error)
    }

    isLoading = false
  }

  function handleDecline() {
    notificationSettings.setDeclined(true)
  }
</script>

{#if shouldShow}
  <div class="bg-primary/20 border-b border-primary/30 px-4 py-3 flex items-center justify-between gap-4">
    <div class="flex items-center gap-3">
      <span class="i-carbon-notification text-primary text-xl flex-shrink-0"></span>
      <p class="text-sm">
        Get notified when you receive new messages
      </p>
    </div>
    <div class="flex items-center gap-2 flex-shrink-0">
      <button
        class="btn-ghost text-sm py-1 px-3"
        onclick={handleDecline}
        disabled={isLoading}
      >
        No Thanks
      </button>
      <button
        class="btn-primary text-sm py-1 px-3"
        onclick={handleEnable}
        disabled={isLoading}
      >
        {#if isLoading}
          Enabling...
        {:else}
          Enable
        {/if}
      </button>
    </div>
  </div>
{/if}
