export async function retryAsync<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[]
): Promise<T> {
  for (const delayMs of delaysMs) {
    try {
      return await fn()
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return fn()
}
