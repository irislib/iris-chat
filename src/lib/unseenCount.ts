export type UnseenCountMessageLike = {
  isMine: boolean
  status?: string
}

export function countUnseenMessages(messages: Iterable<UnseenCountMessageLike>): number {
  let count = 0
  for (const message of messages) {
    if (message.isMine) continue
    if (message.status === 'seen') continue
    count += 1
  }
  return count
}

export function formatUnseenCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

