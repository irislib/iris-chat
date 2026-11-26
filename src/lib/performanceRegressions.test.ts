import 'fake-indexeddb/auto'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { Marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { db, saveSession, saveGroup, deleteMessage, purgeExpiredMessageMutations, type StoredMessage } from './storage'
import { savePrivateStateEvent, applyMessageRead, privateStateVersion } from './privateStateStore'
import { refreshPrivateStateView } from './privateStateView'
import { messageMarkdown } from './messageMarkdown'
import { mentionNames } from './mentionNames'
import { formatMention, messageMentions } from './mentions'
import { contactMemory, rememberContact } from './contactMemory'
import { buildDeviceSyncSnapshots, applyDeviceSyncSnapshot, parseDeviceSyncPacket } from './deviceSync'
import { encodeDeviceSyncPacket } from './deviceSyncProtocol'
import { createDeviceSyncRecordAdapter } from './deviceSyncRecordAdapter'
import { chats, clearChatData, loadChatsFromStorage, type ChatSession } from './chat'
import { groups, groupMessages, clearGroupData, loadGroupsFromStorage } from './groups'
import { identity } from './identity'
import { clearMessageRequestDecisions } from './messageRequests'
import { devices } from './devices'
import { insertMessageOrdered, extractReplyToId, mergeRelayPublishFields } from './chatMessageHelpers'
import { formatChatListTime, formatMessageTime } from './utils'

vi.mock('./notifications', () => ({ updateDMSubscription: vi.fn() }))
vi.mock('./profile', async () => {
  const { readable } = await import('svelte/store')
  return {
    createProfileStore: () => readable(undefined),
    getProfileName: (p: { display_name?: string; name?: string } | undefined) => p?.display_name || p?.name || '',
  }
})
const syncGroupsSpy = vi.fn(async () => {})
vi.mock('./privateChats', () => ({
  getNdrRuntime: () => ({
    getState: () => ({ sessionManagerReady: true, currentDevicePubkey: '0'.repeat(64), registeredDevices: [] }),
    getSessionUserRecords: () => new Map(),
    getKnownAppKeysSnapshots: () => [],
    applyTrustedAppKeysSnapshot: async () => {},
    onGroupEvent: () => () => {},
    onSessionEvent: () => () => {},
    onDurableSessionEvent: () => () => {},
    onStateChange: () => () => {},
    syncGroups: syncGroupsSpy,
    deleteChat: async () => {},
    removeGroup: () => {},
  }),
  waitForNdrRuntime: async () => ({
    syncGroups: syncGroupsSpy,
    getSessionUserRecords: () => new Map(),
  }),
  waitForSendReadyRuntime: async () => ({}),
  ensureDeviceRegistered: async () => {},
  preparePeerNdrRuntime: async () => {},
  republishInvite: async () => {},
  cancelGroupPublications: () => {},
  cancelDirectPublications: () => {},
}))

function hexKey(n: number): string {
  return n.toString(16).padStart(64, '0')
}

function referenceMarkdown(text: string, names: Record<string, string> = {}): string {
  const escape = (s: string) =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const renderer = new Renderer()
  renderer.link = function (token) {
    const mention = messageMentions(token.raw)[0]
    if (mention?.start === 0 && mention.end === token.raw.length) {
      const label = names[mention.pubkey] ? '@' + names[mention.pubkey] : mention.label
      return `<a href="#profile-${mention.pubkey}" class="message-mention">${escape(label)}</a>`
    }
    return `<a href="${escape(token.href)}" target="_blank" rel="noopener noreferrer">${this.parser.parseInline(token.tokens)}</a>`
  }
  return DOMPurify.sanitize(new Marked({ gfm: true, breaks: true, renderer }).parse(text, { async: false }) as string, { ADD_ATTR: ['target'] })
}

describe('performance regressions', () => {
  beforeEach(async () => {
    await clearChatData()
    clearGroupData()
    clearMessageRequestDecisions()
    localStorage.clear()
    syncGroupsSpy.mockClear()
  })

  it('batches startup hydration and private-state projection with bounded IndexedDB queries', async () => {
    const ownerSecret = new Uint8Array(32).fill(9)
    const owner = getPublicKey(ownerSecret)
    const peers = Array.from({ length: 15 }, (_, i) => hexKey(i + 50))
    const baseTime = 1700000000_000

    identity.set({ pubkey: owner, isNip07: false } as never)
    await db.sessionManager.put({ key: 'v1/device-manager/owner-pubkey', value: owner })

    const rows: StoredMessage[] = []
    for (let c = 0; c < peers.length; c++) {
      await saveSession({ id: peers[c], recipientPubkey: peers[c], createdAt: baseTime + c * 1000, mode: 'manager' })
      for (let m = 0; m < 40; m++) {
        rows.push({
          id: `dm-${c}-${m}`,
          sessionId: peers[c],
          content: `msg ${c}-${m}`,
          timestamp: baseTime + (c * 100 + m) * 1000,
          isMine: m % 2 === 0,
        })
      }
    }
    for (let g = 0; g < 5; g++) {
      await saveGroup({
        id: `grp-${g}`,
        name: `Group ${g}`,
        members: [owner, ...peers.slice(0, 4)],
        admins: [owner],
        createdAt: baseTime + g * 1000,
        accepted: true,
      })
      for (let m = 0; m < 40; m++) {
        rows.push({
          id: `gm-${g}-${m}`,
          sessionId: `group:grp-${g}`,
          content: `group msg ${g}-${m}`,
          timestamp: baseTime + (g * 100 + m) * 1000,
          isMine: m % 4 === 0,
          senderPubkey: m % 4 === 0 ? owner : peers[m % 4],
        })
      }
    }
    await db.messages.bulkPut(rows)

    const blockEvent = finalizeEvent({
      kind: 10454,
      created_at: 1700000030,
      content: JSON.stringify({ v: 1, owner, target: peers[0], blocked: false, revision: 2, blockedSince: 1700000010, deletedAt: 0 }),
      tags: [['p', owner], ['d', `iris:block:${peers[0]}`]],
    }, ownerSecret)
    await savePrivateStateEvent(owner, blockEvent, () => true)
    await applyMessageRead(owner, peers[1], 'dm-1-1', { createdAtSecs: Math.floor((baseTime + 101_000) / 1000) }, () => true)

    let smGet = 0
    let smWhere = 0
    let msgGet = 0
    let msgWhere = 0
    const origSmGet = db.sessionManager.get.bind(db.sessionManager)
    const origSmWhere = db.sessionManager.where.bind(db.sessionManager)
    const origMsgGet = db.messages.get.bind(db.messages)
    const origMsgWhere = db.messages.where.bind(db.messages)
    db.sessionManager.get = ((...args: Parameters<typeof origSmGet>) => { smGet++; return origSmGet(...args) }) as typeof db.sessionManager.get
    db.sessionManager.where = ((...args: Parameters<typeof origSmWhere>) => { smWhere++; return origSmWhere(...args) }) as typeof db.sessionManager.where
    db.messages.get = ((...args: Parameters<typeof origMsgGet>) => { msgGet++; return origMsgGet(...args) }) as typeof db.messages.get
    db.messages.where = ((...args: Parameters<typeof origMsgWhere>) => { msgWhere++; return origMsgWhere(...args) }) as typeof db.messages.where

    let chatUpdates = 0
    let groupUpdates = 0
    let groupMsgUpdates = 0
    const u1 = chats.subscribe(() => { chatUpdates++ })
    const u2 = groups.subscribe(() => { groupUpdates++ })
    const u3 = groupMessages.subscribe(() => { groupMsgUpdates++ })
    chatUpdates = groupUpdates = groupMsgUpdates = 0

    try {
      await loadGroupsFromStorage()
      await loadChatsFromStorage()

      expect(chatUpdates).toBe(1)
      expect(groupUpdates).toBe(1)
      expect(groupMsgUpdates).toBe(1)
      expect(syncGroupsSpy).toHaveBeenCalledTimes(1)
      expect(smGet).toBe(0)
      expect(msgGet).toBe(0)
      expect(smWhere).toBeLessThanOrEqual(20)
      expect(msgWhere).toBe(20)

      // Block interval [1700000010, 1700000030) hides peer[0]'s incoming messages in that range
      const peer0Msgs = get(chats).get(peers[0])?.messages ?? []
      expect(peer0Msgs.some(m => !m.isMine && m.timestamp >= 1700000010_000 && m.timestamp < 1700000030_000)).toBe(false)
      // Pending read projected onto dm-1-1
      const peer1Msg = get(chats).get(peers[1])?.messages.find(m => m.id === 'dm-1-1')
      expect(peer1Msg?.status).toBe('seen')

      // refreshPrivateStateView runs in O(1) DB queries instead of O(M)
      smGet = smWhere = msgGet = msgWhere = 0
      await refreshPrivateStateView(owner, () => true)
      expect(smGet).toBe(0)
      expect(msgGet).toBe(0)
      expect(smWhere).toBeLessThanOrEqual(3)
    } finally {
      u1(); u2(); u3()
      db.sessionManager.get = origSmGet
      db.sessionManager.where = origSmWhere
      db.messages.get = origMsgGet
      db.messages.where = origMsgWhere
    }
  })

  it('purges message mutations via target index without scanning unrelated device records', async () => {
    const owner = hexKey(77)
    const peer = hexKey(78)
    await db.sessionManager.bulkPut(
      Array.from({ length: 300 }, (_, i) => ({
        key: `device-record-v1:${owner}:reaction:${JSON.stringify([peer, `m-${i}`, owner])}`,
        value: { chatId: peer, id: hexKey(1000 + i), author: owner, createdAt: 100, messageId: `m-${i}`, emoji: '👍' },
      })),
    )
    const mutKey = `device-record-v1:${owner}:messageMutation:${JSON.stringify([peer, 'mut-1'])}`
    const idxKey = `message-mutation-target:${owner}:${JSON.stringify([peer, 'target-1'])}`
    await db.sessionManager.bulkPut([
      { key: mutKey, value: { chatId: peer, id: 'mut-1', author: owner, messageId: 'target-1', createdAt: 100, operation: 'edit', content: 'edited', expiresAt: 200 } },
      { key: idxKey, value: ['mut-1'] },
    ])
    await db.messages.put({ id: 'target-1', sessionId: peer, content: 'edited', timestamp: 100_000, isMine: true })

    let scannedPrefixes: string[] = []
    const origWhere = db.sessionManager.where.bind(db.sessionManager)
    db.sessionManager.where = ((index: string) => {
      const clause = origWhere(index)
      const origStartsWith = clause.startsWith.bind(clause)
      clause.startsWith = ((prefix: string) => {
        scannedPrefixes.push(prefix)
        return origStartsWith(prefix)
      }) as typeof clause.startsWith
      return clause
    }) as typeof db.sessionManager.where

    try {
      await purgeExpiredMessageMutations(300)
      await deleteMessage('target-1')
    } finally {
      db.sessionManager.where = origWhere
    }

    expect(scannedPrefixes.every(p => p === 'message-mutation-target:')).toBe(true)
    expect(await db.sessionManager.get(mutKey)).toBeUndefined()
    expect(await db.sessionManager.get(idxKey)).toBeUndefined()
  })

  it('renders messageMarkdown identically to uncached marked + DOMPurify across edge cases', () => {
    const peerA = hexKey(11)
    const peerB = hexKey(12)
    const samples = [
      '',
      'Hello world',
      "Hey, it's me! Meeting #42 is at 3pm.",
      'Quoted "text" with numbers 100% ok.',
      '  leading and trailing spaces  ',
      '# Heading text',
      '- bullet item',
      '+ plus item',
      '1. ordered item',
      'Line one\nLine two',
      'Here is **bold**, *italic*, ~~strike~~, and `code`.',
      'Check https://example.com/a?b=1&c=2 and www.example.org',
      'Email test@example.com',
      'Unsafe <img src=x onerror=alert(1)> <script>evil()</script> & > <',
      `Ping ${formatMention(peerA, 'Alice')} and ${formatMention(peerB, 'Bob')}!`,
    ]
    const names1 = { [peerA]: 'Alice Local' }
    const names2 = { [peerA]: 'Alice Renamed', [peerB]: 'Bob Local' }

    for (const sample of samples) {
      expect(messageMarkdown(sample, names1)).toBe(referenceMarkdown(sample, names1))
      // Warm cache hit produces exact same HTML
      expect(messageMarkdown(sample, names1)).toBe(referenceMarkdown(sample, names1))
      // Name change invalidates mention cache cleanly
      expect(messageMarkdown(sample, names2)).toBe(referenceMarkdown(sample, names2))
    }
  })

  it('avoids spurious mentionNames emissions for empty pubkeys and unrelated ticks', () => {
    const owner = hexKey(21)
    const peer = hexKey(22)
    identity.set({ pubkey: owner, isNip07: false } as never)

    const emptyA = mentionNames([], false)
    const emptyB = mentionNames(['not-a-hex-key'], false)
    expect(emptyA).toBe(emptyB)

    let emptyEmissions = 0
    const unsubEmpty = emptyA.subscribe(() => { emptyEmissions++ })
    emptyEmissions = 0

    let peerEmissions = 0
    let lastValue: Record<string, string> = {}
    const unsubPeer = mentionNames([peer], false).subscribe((val) => { peerEmissions++; lastValue = val })
    peerEmissions = 0

    for (let i = 0; i < 5; i++) privateStateVersion.update(n => n + 1)
    expect(emptyEmissions).toBe(0)
    expect(peerEmissions).toBe(0)

    rememberContact(owner, peer)
    contactMemory.observeKnown(owner, peer, 'Tea Friend')
    expect(peerEmissions).toBe(1)
    expect(lastValue[peer]).toBe('Tea Friend')

    unsubEmpty()
    unsubPeer()
  })

  it('chunks device sync snapshots within maxBytes and batches record imports', async () => {
    const owner = hexKey(31)
    const peer = hexKey(32)
    const chat: ChatSession = {
      id: peer,
      recipientPubkey: peer,
      mode: 'manager',
      messages: Array.from({ length: 120 }, (_, i) => ({
        id: `m-${i}`,
        content: `Payload ${i} — unicode café 🚀 ${'x'.repeat(80)}`,
        timestamp: (1700001000 + i) * 1000,
        isMine: i % 2 === 0,
      })),
    }

    const maxBytes = 4096
    const packets = buildDeviceSyncSnapshots({
      requestRosterAt: 1700001000,
      localRosterAt: 1700001000,
      ownerPubkey: owner,
      appKeys: [],
      chats: [chat],
      groups: [],
      groupMessages: new Map(),
      chatPins: [{ chatId: peer, pinned: true, updatedAtMs: 1700001000_000 }],
      chatMutes: [{ chatId: peer, untilSecs: 0, updatedAtMs: 1700001000_000 }],
    }, maxBytes)

    expect(packets.length).toBeGreaterThan(1)
    const roundTrippedIds: string[] = []
    for (const packet of packets) {
      const encoded = encodeDeviceSyncPacket(packet)
      expect(encoded.byteLength).toBeLessThanOrEqual(maxBytes)
      const parsed = parseDeviceSyncPacket(encoded, owner)
      expect(parsed.type).toBe('snapshot')
      if (parsed.type === 'snapshot') roundTrippedIds.push(...parsed.messages.map(m => m.id))
    }
    expect(roundTrippedIds).toHaveLength(120)

    // Batch import 32 history records via adapter
    devices.setRegisteredDevices([{ identityPubkey: owner, createdAt: 1700000000 }], 1700000000)
    const adapter = createDeviceSyncRecordAdapter({
      owner,
      snapshots: () => [],
      messages: () => [],
      allowsLegacy: () => false,
      applySnapshot: (packet, since, auth, legacy) => applyDeviceSyncSnapshot(packet, owner, since, auth, legacy),
    })

    let chatStoreUpdates = 0
    const unsub = chats.subscribe(() => { chatStoreUpdates++ })
    chatStoreUpdates = 0
    let sessionsPut = 0
    const origSessionsPut = db.sessions.put.bind(db.sessions)
    db.sessions.put = ((...args: Parameters<typeof origSessionsPut>) => { sessionsPut++; return origSessionsPut(...args) }) as typeof db.sessions.put

    try {
      const batch = Array.from({ length: 32 }, (_, i) => ({
        type: 'message' as const,
        message: {
          chatId: peer,
          id: `batch-in-${i}`,
          body: `Synced message ${i}`,
          author: i % 2 === 0 ? owner : peer,
          createdAt: 1700002000 + i,
        },
      }))
      const result = await adapter.applyRecords(`02${peer}`, batch, 'history', 1700000000, 1700005000, undefined, () => true)
      expect(result.imported).toBe(32)
      expect(chatStoreUpdates).toBe(1)
      expect(sessionsPut).toBe(1)
      expect(get(chats).get(peer)?.messages).toHaveLength(32)
    } finally {
      unsub()
      db.sessions.put = origSessionsPut
    }
  })

  it('maintains ordered insertion, reply extraction, relay merge, and cached time formatters', () => {
    const sorted = [
      { id: 'a', timestamp: 100 },
      { id: 'b', timestamp: 200 },
      { id: 'c', timestamp: 200 },
    ]
    expect(insertMessageOrdered(sorted, { id: 'd', timestamp: 300 }).map(m => m.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(insertMessageOrdered(sorted, { id: 'e', timestamp: 200 }).map(m => m.id)).toEqual(['a', 'b', 'c', 'e'])
    expect(insertMessageOrdered(sorted, { id: 'f', timestamp: 150 }).map(m => m.id)).toEqual(['a', 'f', 'b', 'c'])
    expect(insertMessageOrdered(sorted, { id: 'g', timestamp: 50 }).map(m => m.id)).toEqual(['g', 'a', 'b', 'c'])

    expect(extractReplyToId([['e', 'root-1', '', 'root'], ['e', 'reply-1', '', 'reply']])).toBe('reply-1')
    expect(extractReplyToId([['e', 'root-1', '', 'root']])).toBeUndefined()
    expect(extractReplyToId([['e', 'legacy-1']])).toBe('legacy-1')

    expect(mergeRelayPublishFields({ sentToRelays: ['wss://a'], deliveryChannels: ['message server: wss://a'] }, ['wss://a'])).toBeNull()
    expect(mergeRelayPublishFields({}, ['wss://b', 'wss://a'])).toEqual({
      sentToRelays: ['wss://a', 'wss://b'],
      deliveryChannels: ['message server: wss://a', 'message server: wss://b'],
    })

    const now = new Date(2026, 4, 10, 14, 30)
    const todayTs = new Date(2026, 4, 10, 9, 15).getTime()
    const earlierTs = new Date(2026, 4, 8, 9, 15).getTime()
    expect(formatChatListTime(todayTs, now)).toBe(formatMessageTime(todayTs))
    expect(formatChatListTime(earlierTs, now)).toBe(new Date(earlierTs).toLocaleDateString([], { month: 'short', day: 'numeric' }))
  })
})
