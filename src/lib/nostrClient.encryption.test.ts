import { afterEach, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'
import { ExtensionSigner, SecretKeySigner } from './nostrClient'

const secret = generateSecretKey()
const owner = getPublicKey(secret)
const plaintext = JSON.stringify({ nickname: 'A private name', note: 'A private note' })
afterEach(() => vi.unstubAllGlobals())

it('uses the same NIP44 self-encryption through local and extension signers', async () => {
  const local = new SecretKeySigner(Buffer.from(secret).toString('hex'))
  const key = nip44.v2.utils.getConversationKey(secret, owner)
  const encrypt = vi.fn(async (recipient: string, value: string) => {
    expect(recipient).toBe(owner)
    return nip44.v2.encrypt(value, key)
  })
  const decrypt = vi.fn(async (sender: string, value: string) => {
    expect(sender).toBe(owner)
    return nip44.v2.decrypt(value, key)
  })
  vi.stubGlobal('window', { nostr: { getPublicKey: async () => owner,
    signEvent: async (draft: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(draft, secret),
    nip44: { encrypt, decrypt } } })
  const extension = new ExtensionSigner()
  const encrypted = await local.nip44Encrypt(owner, plaintext)
  expect(encrypted).not.toContain('A private')
  expect(await extension.nip44Decrypt(owner, encrypted)).toBe(plaintext)
  expect(await local.nip44Decrypt(owner, await extension.nip44Encrypt(owner, plaintext))).toBe(plaintext)
  expect(encrypt).toHaveBeenCalledOnce()
  expect(decrypt).toHaveBeenCalledOnce()
})

it('fails explicitly when the signer cannot encrypt private contact data', async () => {
  vi.stubGlobal('window', { nostr: { getPublicKey: async () => owner,
    signEvent: async (draft: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(draft, secret) } })
  const signer = new ExtensionSigner()
  await expect(signer.nip44Encrypt(owner, plaintext)).rejects.toThrow('Private sync needs an updated signer')
  await expect(signer.nip44Decrypt(owner, 'ciphertext')).rejects.toThrow('Private sync needs an updated signer')
})
