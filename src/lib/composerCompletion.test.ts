import { expect, it } from 'vitest'
import { decodeDraft, encodeDraft, editDraft, insertCompletion, completionAt, exactEmoji, emojiSuggestions } from './composerCompletion'
import { formatMention, messageMentions, mentionsOwner, displayMentions } from './mentions'
const alice = 'a'.repeat(64), bob = 'b'.repeat(64)
it('keeps identities with equal local names through editing, insertion, drafts and rendering', () => {
  const wire = `👋 ${formatMention(alice, 'Old')} and ${formatMention(bob, 'Alex')}!`
  const draft = decodeDraft(wire, { [alice]: 'Alex', [bob]: 'Alex' })
  expect(draft.text).toBe('👋 @Alex and @Alex!')
  expect(encodeDraft(editDraft(draft, draft.text + ' Later'))).toBe(wire + ' Later')
  expect(messageMentions(wire).map(m => m.pubkey)).toEqual([alice,bob])
  expect(messageMentions(encodeDraft(editDraft(draft, '👋 @Alec and @Alex!'))).map(m => m.pubkey)).toEqual([bob])
  const next = insertCompletion(decodeDraft('Before @Al after'),7,10,'@Alice',alice)
  expect(next.text).toBe('Before @Alice  after')
  expect(messageMentions(encodeDraft(next))[0].pubkey).toBe(alice)
  expect(displayMentions(wire, { [alice]: 'New' })).toBe('👋 @New and @Alex!')
})
it('requires canonical identity; ignores quoted and forwarded notifications', () => {
  const mention = formatMention(alice, '@Alice[]\\\n')
  expect(displayMentions(mention)).toBe('@Alice')
  expect(mentionsOwner(mention, alice)).toBe(true)
  for (const text of ['@Alice', mention.replace('npub1','npub0'), `↩ Bob: ${mention}\n\nThanks`, `Forwarded:\n\n${mention}`]) expect(mentionsOwner(text,alice)).toBe(false)
  expect(mentionsOwner(`↩ Bob: hi\n\n${mention}`,alice)).toBe(true)
})
it('opens bare mentions, bounds and filters emoji, preserves ordinary punctuation and selections', () => {
  expect(completionAt('Hi @',4)).toMatchObject({ kind:'mention', query:'', start:3 })
  expect(completionAt(':sm',3)).toMatchObject({ kind:'emoji', query:'sm' })
  for (const text of ['email@bob', 'https:', '12:30', '::', ':smile::', '::smile:', ':'+'x'.repeat(65)]) expect(completionAt(text,text.length)).toBeUndefined()
  expect(completionAt('hello :sm',9,10)).toBeUndefined()
  expect(completionAt(':s:',3)).toMatchObject({ closed:true })
  expect(exactEmoji('+1')).toBe('👍')
  expect(exactEmoji('THUMBS-UP')).toBe('👍')
  expect(emojiSuggestions('smile').length).toBeLessThanOrEqual(6)
  expect(exactEmoji('no_such_emoji')).toBeUndefined()
})
