// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { HashTree, MemoryStore, decryptChk, nhashDecode, sha256, toHex, tryDecodeTreeNode } from '@hashtree/core'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

vi.mock('./identity', () => ({ getPubkey: vi.fn(), getPrivkeyBytes: vi.fn(), isNip07Login: () => false }))
import { getPubkey, getPrivkeyBytes } from './identity'
import { uploadFile } from './hashtree'
afterEach(() => vi.unstubAllGlobals())

it('encrypts every uploaded attachment chunk and cannot read it with the hash alone', async () => {
  const secret = generateSecretKey()
  vi.mocked(getPubkey).mockReturnValue(getPublicKey(secret))
  vi.mocked(getPrivkeyBytes).mockReturnValue(secret)
  let blobs = new Map<string, Uint8Array>()
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 404 })
    expect(init?.method).toBe('PUT')
    const bytes = new Uint8Array(await (init!.body as Blob).arrayBuffer())
    const hash = toHex(await sha256(bytes))
    blobs.set(hash, bytes)
    return Response.json({ sha256: hash }, { status: 201 })
  }))
  const large = Uint8Array.from({ length: 5 * 1024 * 1024 + 123 }, (_, i) => (i * 37) ^ (i >> 8))
  for (const [name, bytes] of [
    ['photo.png', new TextEncoder().encode('\x89PNG Private photo bytes')],
    ['voice.m4a', new TextEncoder().encode('Private recorded voice bytes')],
    ['document.txt', new TextEncoder().encode('Private attachment regression fixture')],
    ['video.mp4', large],
    ['empty.txt', new Uint8Array()],
  ] as const) {
    blobs = new Map()
    const result = await uploadFile(new File([bytes], name))
    const cid = nhashDecode(result.nhash)
    expect(cid.key, name).toHaveLength(32)
    const store = new MemoryStore()
    const pending = [cid], visited = new Set<string>()
    while (pending.length) {
      const node = pending.pop()!, hash = toHex(node.hash)
      if (visited.has(hash)) continue
      visited.add(hash)
      expect(node.key, `${name}: each root and child needs a key`).toHaveLength(32)
      const cipher = blobs.get(hash)!
      expect(cipher, `${name}: the real upload must store every node`).toBeDefined()
      await store.put(node.hash, cipher)
      const plain = await decryptChk(cipher, node.key!)
      expect(cipher).not.toEqual(plain)
      const wrong = new Uint8Array(node.key!); wrong[0] ^= 1
      await expect(decryptChk(cipher, wrong)).rejects.toThrow()
      const tree = tryDecodeTreeNode(plain)
      if (tree) pending.push(...tree.links.map(link => ({ hash: link.hash, key: link.key })))
    }
    expect(visited.size).toBe(blobs.size)
    // A fresh reader has only the uploaded ciphertext, never the sender's cache.
    const reader = new HashTree({ store })
    expect(await reader.readFile(cid)).toEqual(bytes)
    const unkeyed = await reader.readFile({ hash: cid.hash }).catch(() => null)
    expect(unkeyed).not.toEqual(bytes)
  }
})
