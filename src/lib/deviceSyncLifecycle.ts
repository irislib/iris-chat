interface LifecycleOptions {
  currentOwner(): string | null
  start(owner: string): void
  stop(): Promise<void>
}

/** Page teardown starts synchronously; BFCache recovery waits for its completion. */
export function createDeviceSyncLifecycle(target: EventTarget, options: LifecycleOptions) {
  let requestedOwner: string | null = null
  let hidden = false, disposed = false, revision = 0
  let closing: Promise<void> = Promise.resolve()
  function startWhenReady(): Promise<void> {
    const run = ++revision
    return closing.then(() => {
      if (disposed || hidden || run !== revision || !requestedOwner || options.currentOwner() !== requestedOwner) return
      options.start(requestedOwner)
    })
  }
  function stopNow(): Promise<void> {
    revision++
    // Invoke before awaiting earlier cleanup so an in-flight startup is invalidated now.
    const stopped = options.stop()
    closing = Promise.all([closing, stopped]).then(() => undefined)
    return closing
  }
  const hide = () => { hidden = true; void stopNow().catch(() => undefined) }
  const show = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted || !hidden || disposed) return
    hidden = false
    void startWhenReady().catch(() => undefined)
  }
  target.addEventListener('pagehide', hide)
  target.addEventListener('pageshow', show)
  return {
    start(owner: string): Promise<void> {
      if (disposed || options.currentOwner() !== owner) return Promise.resolve()
      requestedOwner = owner
      return startWhenReady()
    },
    stop(): Promise<void> { requestedOwner = null; return stopNow() },
    dispose(): Promise<void> {
      disposed = true; requestedOwner = null
      target.removeEventListener('pagehide', hide)
      target.removeEventListener('pageshow', show)
      return stopNow()
    },
  }
}
