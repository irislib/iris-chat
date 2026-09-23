import { createSocket } from 'node:dgram'

/** Receives real STUN binding requests and deliberately never replies. */
export async function startSilentStunServer() {
  const socket = createSocket('udp4')
  let requests = 0
  socket.on('message', packet => {
    if (packet.length >= 20 && packet.readUInt16BE(0) === 0x0001
      && packet.readUInt32BE(4) === 0x2112a442) requests++
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', () => { socket.off('error', reject); resolve() })
  })
  return {
    url: `stun:127.0.0.1:${socket.address().port}`,
    requests: () => requests,
    close: () => new Promise<void>(resolve => socket.close(() => resolve())),
  }
}
