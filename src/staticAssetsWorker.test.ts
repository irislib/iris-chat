// @vitest-environment node

import { readFile } from 'node:fs/promises'

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

  it('redirects plain HTTP requests to HTTPS before assets', async () => {
    const assetFetch = vi.fn(async () => new Response('unexpected', { status: 500 }))

    const response = await worker.fetch(new Request('http://chat.iris.to/#/invite'), {
      ASSETS: { fetch: assetFetch },
    })

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('https://chat.iris.to/#/invite')
    expect(assetFetch).not.toHaveBeenCalled()
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

  it('serves policy routes from static documents instead of the app shell', async () => {
    const assetFetch = vi.fn(async (request: Request | URL | string) => {
      throw new Error(`policy routes should not hit assets: ${String(request)}`)
    })

    const response = await worker.fetch(new Request('https://chat.iris.to/csae/', {
      headers: { accept: 'text/html' },
    }), {
      ASSETS: { fetch: assetFetch },
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Child Safety Standards')
    expect(assetFetch).not.toHaveBeenCalled()
  })

  it('serves policy routes without redirecting', async () => {
    const assetFetch = vi.fn(async () => {
      return new Response('<html><body><h1>Child Safety Standards</h1></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })

    const response = await worker.fetch(new Request('https://chat.iris.to/privacy', {
      headers: { accept: 'text/html' },
    }), {
      ASSETS: { fetch: assetFetch },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toContain('Privacy Policy')
  })

  it('ships legal policy pages as static documents', async () => {
    const pages = [
      ['privacy', 'Privacy Policy'],
      ['terms', 'Terms of Use'],
      ['csae', 'Child Safety Standards'],
    ]

    for (const [slug, heading] of pages) {
      const html = await readFile(new URL(`../public/${slug}.html`, import.meta.url), 'utf8')
      expect(html).toContain(`<h1>${heading}</h1>`)
      expect(html).not.toContain('<div id="app"></div>')
    }
  })
})
