import { derived, readable, type Readable } from 'svelte/store'
import { createProfileStore, getProfileName } from './profile'
import { contactMemory } from './contactMemory'
import { identity } from './identity'
import { getAnimalName } from './animalNames'

const EMPTY_NAMES: Readable<Record<string, string>> = readable(Object.freeze({}))

function sameRecord(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (!a) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of bKeys) if (a[key] !== b[key]) return false
  return true
}

/** Same local nickname/accepted-name precedence as the normal Name component. */
export function mentionNames(pubkeys: string[], fallback = true): Readable<Record<string, string>> {
  const keys = [...new Set(pubkeys)].filter(key => /^[0-9a-f]{64}$/.test(key))
  if (keys.length === 0) return EMPTY_NAMES
  const profiles = derived(keys.map(key => createProfileStore(key)), values => values)
  let previous: Record<string, string> | undefined
  return derived<[typeof profiles, typeof contactMemory, typeof identity], Record<string, string>>(
    [profiles, contactMemory, identity],
    ([values, , account], set) => {
      const next: Record<string, string> = {}
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        const memory = contactMemory.get(account?.pubkey ?? '', key)
        const name = memory?.nickname || memory?.accepted_name || getProfileName(values[index]) || (fallback ? getAnimalName(key) : undefined)
        if (name) next[key] = name
      }
      if (sameRecord(previous, next)) return
      previous = next
      set(next)
    },
    {},
  )
}
