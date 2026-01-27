import { writable } from 'svelte/store'

export interface MediaModalState {
  open: boolean
  src: string | null
  nhash: string | null
  filename: string
  type: 'image' | 'video'
}

const initialState: MediaModalState = {
  open: false,
  src: null,
  nhash: null,
  filename: '',
  type: 'image',
}

export const mediaModal = writable<MediaModalState>(initialState)

/** Open modal with already-loaded media */
export function openMediaModal(src: string | null, filename: string, type: 'image' | 'video') {
  mediaModal.set({ open: true, src, nhash: null, filename, type })
}

/** Open modal and load media from nhash */
export function openMediaModalWithNhash(nhash: string, filename: string, type: 'image' | 'video') {
  mediaModal.set({ open: true, src: null, nhash, filename, type })
}

export function closeMediaModal() {
  mediaModal.set(initialState)
}
