<script lang="ts">
  import { notificationSettings } from '../lib/notificationStore'
  import { subscribeToDMNotifications } from '../lib/notifications'
  import { getNotificationSupportError } from '../lib/notificationPermission'

  let settings = $derived($notificationSettings)

  let isLoading = $state(false)
  let permissionState = $state<NotificationPermission>('default')
  let hasAutoSubscribed = $state(false)
  let errorMessage = $state('')

  // Check permission on mount and auto-subscribe if already granted
  $effect(() => {
    if (!getNotificationSupportError()) {
      permissionState = Notification.permission

      // Auto-subscribe if permission is already granted but not yet subscribed
      if (permissionState === 'granted' && !settings.enabled && !hasAutoSubscribed) {
        hasAutoSubscribed = true
        subscribeToDMNotifications().then(result => {
          if (!result.success) errorMessage = result.error || 'Failed to enable notifications'
        })
      }
    }
  })

  // Show prompt if:
  // - Push notifications are supported
  // - Permission hasn't been requested, or enabling failed
  // - User hasn't declined
  // - Notifications are not already enabled
  let shouldShow = $derived(
    !getNotificationSupportError() &&
    (permissionState === 'default' || !!errorMessage) &&
    !settings.declined &&
    !settings.enabled
  )

  async function handleEnable() {
    isLoading = true
    errorMessage = ''
    hasAutoSubscribed = true

    try {
      const result = await subscribeToDMNotifications()
      if (!result.success) errorMessage = result.error || 'Failed to enable notifications'
    } catch {
      errorMessage = 'Failed to enable notifications. Please try again.'
    } finally {
      if ('Notification' in window) permissionState = Notification.permission
      isLoading = false
    }
  }

  function handleDecline() {
    notificationSettings.setDeclined(true)
  }
</script>

{#if shouldShow}
  <div class="bg-primary/20 border-b border-primary/30 px-4 py-3 flex items-center justify-between gap-4 flex-shrink-0">
    <div class="flex items-center gap-3">
      <span class="i-carbon-notification text-primary text-xl flex-shrink-0"></span>
      <div class="text-sm">
        <p>Get notified when you receive new messages</p>
        {#if errorMessage}<p class="mt-1 text-red-400" role="alert">{errorMessage}</p>{/if}
      </div>
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
