import { derived } from 'svelte/store'
import { createProfileStore, getProfileName } from './profile'
import { contactMemory } from './contactMemory'
import { identity } from './identity'
import { getAnimalName } from './animalNames'

/** Same local nickname/accepted-name precedence as the normal Name component. */
export function mentionNames(pubkeys: string[], fallback = true) {
  const keys = [...new Set(pubkeys)].filter(key => /^[0-9a-f]{64}$/.test(key))
  const profiles = derived(keys.map(key => createProfileStore(key)), values => values)
  return derived([profiles, contactMemory, identity], ([values, , account]) => Object.fromEntries(keys.flatMap((key, index) => {
    const memory = contactMemory.get(account?.pubkey ?? '', key)
    const name = memory?.nickname || memory?.accepted_name || getProfileName(values[index]) || (fallback ? getAnimalName(key) : undefined)
    return name ? [[key, name]] : []
  })))
}
