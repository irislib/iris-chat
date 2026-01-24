const adjectives = [
  'Happy', 'Sleepy', 'Bouncy', 'Fluffy', 'Sneaky', 'Grumpy', 'Jolly', 'Lazy',
  'Brave', 'Clever', 'Swift', 'Gentle', 'Mighty', 'Noble', 'Proud', 'Silent',
  'Wise', 'Wild', 'Calm', 'Fierce', 'Golden', 'Silver', 'Cosmic', 'Mystic',
  'Dancing', 'Singing', 'Glowing', 'Sparkling', 'Daring', 'Curious', 'Playful',
  'Serene', 'Bold', 'Charming', 'Elegant', 'Fancy', 'Graceful', 'Heroic'
]

const animals = [
  'Penguin', 'Panda', 'Koala', 'Otter', 'Fox', 'Wolf', 'Bear', 'Lion',
  'Tiger', 'Eagle', 'Owl', 'Hawk', 'Dolphin', 'Whale', 'Shark', 'Octopus',
  'Rabbit', 'Deer', 'Moose', 'Elk', 'Bison', 'Raccoon', 'Badger', 'Beaver',
  'Hedgehog', 'Squirrel', 'Chipmunk', 'Giraffe', 'Elephant', 'Rhino', 'Hippo',
  'Zebra', 'Cheetah', 'Leopard', 'Jaguar', 'Panther', 'Lynx', 'Cougar',
  'Falcon', 'Raven', 'Crow', 'Sparrow', 'Robin', 'Cardinal', 'Pelican',
  'Flamingo', 'Peacock', 'Swan', 'Goose', 'Duck', 'Crane', 'Heron', 'Stork',
  'Parrot', 'Toucan', 'Finch', 'Canary', 'Puffin', 'Penguin', 'Seal', 'Walrus'
]

// Deterministic hash function for pubkey
function hashCode(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash)
}

export function getAnimalName(pubkey: string): string {
  const hash = hashCode(pubkey)
  const adjIndex = hash % adjectives.length
  const animalIndex = Math.floor(hash / adjectives.length) % animals.length

  return `${adjectives[adjIndex]} ${animals[animalIndex]}`
}

export function getDisplayName(pubkey: string, customName: string | null): string {
  if (customName && customName.trim()) {
    return customName.trim()
  }
  return getAnimalName(pubkey)
}
