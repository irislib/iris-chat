import { describe, it, expect } from 'vitest'
import { deriveMessageReceiptInfo, partitionReceiptStages } from './messageInfo'

describe('messageInfo', () => {
  describe('partitionReceiptStages', () => {
    it('keeps seen users out of delivered list', () => {
      const lists = partitionReceiptStages(['alice', 'bob'], ['bob'])
      expect(lists.deliveredBy).toEqual(['alice'])
      expect(lists.seenBy).toEqual(['bob'])
    })

    it('deduplicates users while preserving first-seen order', () => {
      const lists = partitionReceiptStages(
        ['alice', 'alice', 'bob', 'carol'],
        ['bob', 'bob', 'dave', 'carol']
      )
      expect(lists.deliveredBy).toEqual(['alice'])
      expect(lists.seenBy).toEqual(['bob', 'dave', 'carol'])
    })
  })

  describe('deriveMessageReceiptInfo', () => {
    it('marks recipient as received and seen for outgoing seen DMs', () => {
      const info = deriveMessageReceiptInfo(
        {
          isMine: true,
          status: 'seen',
        },
        {
          myPubkey: 'me',
          recipientPubkey: 'alice',
        }
      )

      expect(info.scope).toBe('dm')
      expect(info.participants).toEqual(['me', 'alice'])
      expect(info.potentialRecipients).toEqual(['alice'])
      expect(info.recipientRows).toEqual([{ pubkey: 'alice', status: 'seen' }])
      expect(info.receivedBy).toEqual(['alice'])
      expect(info.seenBy).toEqual(['alice'])
      expect(info.notes).toEqual([])
    })

    it('keeps outgoing DMs without receipts empty and adds a note', () => {
      const info = deriveMessageReceiptInfo(
        {
          isMine: true,
        },
        {
          myPubkey: 'me',
          recipientPubkey: 'alice',
        }
      )

      expect(info.scope).toBe('dm')
      expect(info.receivedBy).toEqual([])
      expect(info.seenBy).toEqual([])
      expect(info.recipientRows).toEqual([{ pubkey: 'alice', status: 'waiting' }])
      expect(info.notes).toContain('No delivery receipt yet.')
    })

    it('marks local user as received and seen for incoming seen DMs', () => {
      const info = deriveMessageReceiptInfo(
        {
          isMine: false,
          status: 'seen',
          senderPubkey: 'alice',
        },
        {
          myPubkey: 'me',
          recipientPubkey: 'alice',
        }
      )

      expect(info.scope).toBe('dm')
      expect(info.participants).toEqual(['me', 'alice'])
      expect(info.potentialRecipients).toEqual(['me'])
      expect(info.recipientRows).toEqual([{ pubkey: 'me', status: 'seen' }])
      expect(info.receivedBy).toEqual(['me'])
      expect(info.seenBy).toEqual(['me'])
    })

    it('shows local seen state for incoming group messages', () => {
      const info = deriveMessageReceiptInfo(
        {
          isMine: false,
          status: 'seen',
          senderPubkey: 'alice',
        },
        {
          myPubkey: 'me',
          groupMembers: ['me', 'alice', 'bob'],
        }
      )

      expect(info.scope).toBe('group')
      expect(info.participants).toEqual(['me', 'alice', 'bob'])
      expect(info.potentialRecipients).toEqual(['me', 'bob'])
      expect(info.recipientRows).toEqual([
        { pubkey: 'me', status: 'seen' },
        { pubkey: 'bob', status: 'waiting' },
      ])
      expect(info.receivedBy).toEqual(['me'])
      expect(info.seenBy).toEqual(['me'])
      expect(info.notes).toEqual([])
    })

    it('shows per-recipient group receipts for outgoing messages', () => {
      const info = deriveMessageReceiptInfo(
        {
          isMine: true,
          senderPubkey: 'me',
          recipientStatuses: {
            alice: 'delivered',
            bob: 'seen',
          },
        },
        {
          myPubkey: 'me',
          groupMembers: ['me', 'alice', 'bob'],
        }
      )

      expect(info.scope).toBe('group')
      expect(info.potentialRecipients).toEqual(['alice', 'bob'])
      expect(info.recipientRows).toEqual([
        { pubkey: 'alice', status: 'delivered' },
        { pubkey: 'bob', status: 'seen' },
      ])
      expect(info.receivedBy).toEqual(['alice', 'bob'])
      expect(info.seenBy).toEqual(['bob'])
      expect(info.notes).toEqual([])
    })
  })
})
