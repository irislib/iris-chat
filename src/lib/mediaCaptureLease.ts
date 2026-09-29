/** Owns microphone tracks from request through disposal, including late permission results. */
export function createMediaCaptureLease() {
  let active = true
  let stream: MediaStream | null = null
  return {
    get active() { return active },
    async acquire(request: () => Promise<MediaStream>): Promise<MediaStream | null> {
      if (!active) return null
      const captured = await request()
      if (!active) {
        captured.getTracks().forEach(track => track.stop())
        return null
      }
      stream = captured
      return captured
    },
    close() {
      active = false
      stream?.getTracks().forEach(track => track.stop())
      stream = null
    },
  }
}
