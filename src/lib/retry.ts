export async function retryAsync<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[]
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      if (attempt === delaysMs.length) {
        throw e
      }
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]))
    }
  }

  throw lastError
}
