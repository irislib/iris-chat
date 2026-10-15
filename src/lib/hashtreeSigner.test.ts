// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
vi.mock('./identity', () => ({ getPubkey: vi.fn(), getPrivkeyBytes: vi.fn(), isNip07Login: () => false, isLinkedDeviceLogin: vi.fn() }))
vi.mock('./privateChats', () => ({ getDelegateManager: vi.fn() }))
import { getPubkey, getPrivkeyBytes, isLinkedDeviceLogin } from './identity'
import { getDelegateManager } from './privateChats'
import { createSigner } from './hashtree'
const device = generateSecretKey(), owner = getPublicKey(generateSecretKey())
const authorization = { kind: 24242 as const, created_at: 100, content: 'Upload encrypted blob', tags: [['t','upload'],['x','a'.repeat(64)],['expiration','200']] }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPubkey).mockReturnValue(owner)
  vi.mocked(getPrivkeyBytes).mockReturnValue(null)
  vi.mocked(isLinkedDeviceLogin).mockReturnValue(true)
  vi.mocked(getDelegateManager).mockReturnValue({ getIdentityKey: () => device } as ReturnType<typeof getDelegateManager>)
})
it('authenticates a linked-device encrypted upload with its own key, without owner signing authority', async () => {
  const signed = await createSigner()(authorization)
  expect(signed.pubkey).toBe(getPublicKey(device))
  expect(signed.pubkey).not.toBe(owner)
  expect(verifyEvent(signed)).toBe(true)
  expect(signed.tags).toEqual(authorization.tags)
})
it('does not use a retained delegate after logout', async () => {
  vi.mocked(isLinkedDeviceLogin).mockReturnValue(false)
  await expect(createSigner()(authorization)).rejects.toThrow('No signer available')
  expect(getDelegateManager).not.toHaveBeenCalled()
})

it('never substitutes device authority for owner profile signing', async () => {
  const ownerEvent = { ...authorization, kind: 0 } as unknown as Parameters<ReturnType<typeof createSigner>>[0]
  await expect(createSigner()(ownerEvent)).rejects.toThrow('No signer available')
  expect(getDelegateManager).not.toHaveBeenCalled()
})
