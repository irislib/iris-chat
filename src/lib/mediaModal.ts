import { writable } from 'svelte/store'

export interface MediaModalState {
  open: boolean
  src: string | null
  filename: string
  type: 'image' | 'video'
}

const initialState: MediaModalState = {
  open: false,
  src: null,
  filename: '',
  type: 'image',
}

export const mediaModal = writable<MediaModalState>(initialState)

export function openMediaModal(src: string | null, filename: string, type: 'image' | 'video') {
  mediaModal.set({ open: true, src, filename, type })
}

export function closeMediaModal() {
  mediaModal.set(initialState)
}
