// @vitest-environment node
import { expect, it } from 'vitest'
import { connect } from 'node:net'
import { once } from 'node:events'
import { createDenyProxy } from '../scripts/isolatedBrowser'

it('denies tunnels and remains usable when their clients reset the connection', async () => {
  const proxy = await createDenyProxy()
  const address = new URL(proxy.url)
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const socket = connect({ host: address.hostname, port: Number(address.port) })
      socket.on('error', () => {})
      await once(socket, 'connect')
      socket.write('CONNECT denied.invalid:443 HTTP/1.1\r\nHost: denied.invalid:443\r\n\r\n')
      const [data] = await once(socket, 'data')
      expect(data.toString()).toContain('403 Forbidden')
      const closed = once(socket, 'close')
      socket.resetAndDestroy()
      await closed
    }
    expect(proxy.rejected).toHaveLength(10)
    expect(proxy.rejected.every(request => request.target === 'denied.invalid:443')).toBe(true)
  } finally { await proxy.close() }
})
