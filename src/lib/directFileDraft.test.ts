import { describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import { createDirectFileDraft, directFileSelectionMode } from './directFileDraft'

describe('local direct-file selection', () => {
  it('keeps subsequent file picker, drop and paste selections out of uploads', () => {
    expect(directFileSelectionMode(0, 0, true)).toBe(true)
    expect(directFileSelectionMode(2, 0, false)).toBe(true)
    expect(directFileSelectionMode(0, 0, false)).toBe(false)
  })

  it('refuses to relabel files that have already entered the upload flow', () => {
    expect(() => directFileSelectionMode(0, 1, true)).toThrow('Remove the uploaded files first')
  })

  it('retains all selected files and duplicate names without reading or uploading', () => {
    const files = [new File(['one'], 'notes.txt'), new File(['two'], 'notes.txt')]
    const draft = createDirectFileDraft(() => 'account:chat')
    draft.add(files)
    expect(get(draft).map(item => item.file)).toEqual(files)
    expect(new Set(get(draft).map(item => item.id)).size).toBe(2)
    draft.remove(get(draft)[0].id)
    expect(get(draft).map(item => item.file)).toEqual([files[1]])
  })

  it('does not carry direct files across accounts or chats, even before the UI effect runs', () => {
    let context = 'account:chat'
    const draft = createDirectFileDraft(() => context)
    draft.add([new File(['old'], 'old.txt')])
    context = 'account:other-chat'
    const next = new File(['new'], 'new.txt')
    draft.add([next])
    expect(get(draft).map(item => item.file)).toEqual([next])
    draft.setContext('other-account:other-chat')
    expect(get(draft)).toEqual([])
  })
})
