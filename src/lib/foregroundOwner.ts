let ownership: Promise<(() => void) | null> | undefined

/** The returned release function is only for abandoning admission before login. */
export function claimForegroundOwnership(): Promise<(() => void) | null> {
  return ownership ??= new Promise<(() => void) | null>((resolve, reject) => {
    if (!navigator.locks) {
      reject(new Error('Browser does not support exclusive tab ownership'))
      return
    }
    void navigator.locks.request('iris-chat-foreground-writer', { ifAvailable: true }, lock => {
      if (!lock) { resolve(null); return }
      // Once admitted, hold until document termination, including background/
      // idle time. Never release on component cleanup or visibility changes:
      // asynchronous runtime work could still be writing the shared Dexie state.
      return new Promise<void>(release => {
        let abandoned = false
        resolve(() => {
          if (abandoned) return
          abandoned = true
          ownership = undefined
          release()
        })
      })
    }).catch(reject)
  })
}
