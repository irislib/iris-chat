// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { render } from 'svelte/server'
import DirectFileTransferCard from './DirectFileTransferCard.svelte'
import type { DirectFileTransfer } from '../lib/directFiles'

vi.mock('../lib/directFiles', () => ({
  acceptDirectFiles: vi.fn(), declineDirectFiles: vi.fn(), cancelDirectFiles: vi.fn(), downloadDirectFile: vi.fn(),
}))

const transfer: DirectFileTransfer = {
  id: 'test-transfer', files: [{ filename: 'Notes.txt', sizeBytes: 23 }, { filename: 'Photo.jpg', sizeBytes: 2048 }],
  status: 'offered', isSender: false, transferredBytes: 0, totalBytes: 2071,
}
const html = (changes: Partial<DirectFileTransfer> = {}) => render(DirectFileTransferCard, { props: { transfer: { ...transfer, ...changes } } }).body

describe('direct file offer card', () => {
  it('lets a receiving device accept or decline, including an outgoing self-chat message', () => {
    const body = html()
    expect(body).toContain('Notes.txt')
    expect(body).toContain('Photo.jpg')
    expect(body).toContain('>Accept</button>')
    expect(body).toContain('>Decline</button>')
    expect(body).not.toContain('>Cancel</button>')
    expect(body).not.toContain('aria-label="Download')
  })

  it('only offers Cancel on the sending device before acceptance', () => {
    const body = html({ isSender: true })
    expect(body).toContain('Waiting for acceptance')
    expect(body).toContain('>Cancel</button>')
    expect(body).not.toContain('>Accept</button>')
  })

  it('shows progress and makes completed files downloadable', () => {
    const active = html({ status: 'transferring', transferredBytes: 1000 })
    expect(active).toContain('File transfer progress')
    expect(active).toContain('Receiving…')
    expect(active).toContain('>Cancel</button>')
    const completed = html({ status: 'completed', transferredBytes: 2071 })
    expect(completed).toContain('aria-label="Download Notes.txt"')
    expect(completed).toContain('aria-label="Download Photo.jpg"')
    expect(completed).not.toContain('>Accept</button>')
    expect(completed).not.toContain('>Cancel</button>')
  })

  it('explains a failed transfer without offering acceptance again', () => {
    const body = html({ status: 'failed', error: 'The sending device is no longer available.' })
    expect(body).toContain('The sending device is no longer available.')
    expect(body).not.toContain('>Accept</button>')
  })
})
