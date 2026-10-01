import type { BrowserContext } from '@playwright/test'

export function forbiddenWebSocketOrigins(allowedUrls: readonly string[]): RegExp {
  const origins = [...new Set(allowedUrls.map(value => {
    const url = new URL(value)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Expected a WebSocket URL')
    return url.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }))]
  // Match only forbidden origins, including different schemes and ports.
  // The boundary prevents an allowed hostname from accepting a lookalike.
  return origins.length ? new RegExp(`^(?!(?:${origins.join('|')})(?:/|$))`) : /^/
}

export async function blockOtherWebSockets(context: Pick<BrowserContext, 'routeWebSocket'>, allowedUrls: readonly string[]) {
  // A serializable RegExp lets Playwright pass allowed sockets through inside
  // the browser. A URL predicate becomes a catch-all interception pattern;
  // connectToServer then sends every media packet through the test driver.
  await context.routeWebSocket(forbiddenWebSocketOrigins(allowedUrls), socket => socket.close())
}
