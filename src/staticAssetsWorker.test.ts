// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildSpaDocumentRequest, spaDocumentPath } from '../scripts/static-assets-worker-lib.mjs'
import worker from '../scripts/static-assets-worker.mjs'

class PassthroughHtmlRewriter {
  on() {
    return this
  }

  transform(response: Response) {
    return response
  }
}

describe('static assets worker', () => {
  beforeEach(() => {
    vi.stubGlobal('HTMLRewriter', PassthroughHtmlRewriter)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rewrites the SPA document request to a synthetic path', () => {
    const request = new Request('https://chat.iris.to/')
    const rewritten = buildSpaDocumentRequest(request, new URL(request.url))

    expect(new URL(rewritten.url).pathname).toBe(spaDocumentPath)
  })

  it('serves root requests from the synthetic SPA path instead of /index.html', async () => {
    const assetFetch = vi.fn(async (request: Request | URL | string) => {
      const requestUrl = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
      expect(new URL(requestUrl).pathname).toBe(spaDocumentPath)
      return new Response('<html><head></head><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })

    const response = await worker.fetch(new Request('https://chat.iris.to/'), {
      ASSETS: { fetch: assetFetch },
    })

    expect(response.status).toBe(200)
    expect(assetFetch).toHaveBeenCalledOnce()
  })
})
