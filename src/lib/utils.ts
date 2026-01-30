export function getErrorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (e) {
    console.error('Failed to copy:', e)
    return false
  }
}
