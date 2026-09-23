/** One OS alert per incoming call, including cancellation during async delivery. */
export class CallNotification {
  private current?: { id: string; close?: () => void }

  update(call: { id: string; name: string; video: boolean; chatId?: string } | null) {
    if (call && this.current?.id === call.id) return
    this.clear()
    if (!call || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const alert = { id: call.id, close: undefined as (() => void) | undefined }
    this.current = alert
    const tag = `iris-call-${call.id}`
    const options: NotificationOptions = {
      body: call.video ? 'Incoming video call' : 'Incoming voice call',
      tag, icon: '/img/android-chrome-192x192.png', silent: true, requireInteraction: true,
      data: { chatId: call.chatId, callId: call.id },
    }
    void (async () => {
      try {
        const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
        if (this.current !== alert) return
        if (registration) {
          alert.close = () => { void registration.getNotifications({ tag }).then(items => items.forEach(item => item.close())).catch(() => {}) }
          await registration.showNotification(call.name, options)
          // A remote hangup/answer elsewhere can arrive while the OS posts it.
          if (this.current !== alert) alert.close()
        } else {
          const notification = new Notification(call.name, options)
          alert.close = () => notification.close()
          notification.onclick = () => { window.focus(); notification.close() }
        }
      } catch { /* Permission or OS support may change while the call rings. */ }
    })()
  }

  clear() {
    const previous = this.current
    this.current = undefined
    previous?.close?.()
  }
}
