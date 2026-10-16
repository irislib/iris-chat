/** Group membership permits encrypted file exchange, without granting call permission. */
export function groupAttachmentOwner(owner: string, mine: string | null,
  groups: Iterable<{ members: string[]; accepted?: boolean }>, rejected: Readonly<Record<string, unknown>>) {
  if (!mine || owner === mine || rejected[owner]) return false
  return Array.from(groups).some(group => group.accepted !== false && group.members.includes(mine) && group.members.includes(owner))
}
