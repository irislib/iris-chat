const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const dayLabelFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const dayLabelYearFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })

export function formatMessageTime(timestamp: number): string {
  return timeFormatter.format(timestamp)
}

export function formatChatListTime(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp)
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return timeFormatter.format(date)
  }
  return shortDateFormatter.format(date)
}

export function formatDayLabel(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((today.getTime() - messageDay.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return weekdayFormatter.format(date)
  return date.getFullYear() !== now.getFullYear()
    ? dayLabelYearFormatter.format(date)
    : dayLabelFormatter.format(date)
}

export function isDifferentDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return da.getFullYear() !== db.getFullYear() || da.getMonth() !== db.getMonth() || da.getDate() !== db.getDate()
}

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
