import { expect, it } from 'vitest'
import { ConnectedDevicePeers } from './fipsPeers'

it('keeps a device reachable until its last carrier disconnects', () => {
  const id = 'ab'.repeat(32)
  const rtc = { peerId: id, remotePubkey: `02${id}`, remoteAddr: { transport: 'webrtc', addr: 'rtc' } }
  const ws = { remotePubkey: `03${id}`, remoteAddr: { transport: 'websocket', addr: 'seed' } }
  const roster = new ConnectedDevicePeers()
  roster.update({ ...rtc, state: 'connected' })
  roster.update({ ...ws, state: 'connected' })
  expect(roster.peers()).toEqual([rtc.remotePubkey])
  roster.update({ ...rtc, state: 'disconnected' })
  expect(roster.peers()).toEqual([rtc.remotePubkey])
  roster.update({ ...ws, state: 'disconnected' })
  expect(roster.peers()).toEqual([])
})
