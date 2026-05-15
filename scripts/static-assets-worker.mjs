import { buildSpaDocumentRequest } from './static-assets-worker-lib.mjs'

/**
 * @typedef {{
 *   ASSETS: {
 *     fetch: (request: Request) => Promise<Response>
 *   }
 * }} AssetsEnv
 */

/**
 * @param {Request} request
 * @returns {boolean}
 */
function wantsHtml(request) {
  return request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html')
}

/**
 * @param {string} pathname
 * @returns {boolean}
 */
function hasFileExtension(pathname) {
  return pathname.split('/').pop()?.includes('.') ?? false
}

/**
 * @param {string} pathname
 * @returns {boolean}
 */
function isAssociationFile(pathname) {
  return pathname === '/.well-known/apple-app-site-association' ||
    pathname === '/apple-app-site-association'
}

/**
 * @param {string} pathname
 * @returns {boolean}
 */
function isPolicyDocumentPath(pathname) {
  return pathname === '/privacy' ||
    pathname === '/privacy/' ||
    pathname === '/terms' ||
    pathname === '/terms/' ||
    pathname === '/csae' ||
    pathname === '/csae/'
}

/**
 * @param {Request} request
 * @param {URL} url
 * @returns {Request}
 */
function buildPolicyDocumentRequest(request, url) {
  const policyUrl = new URL(url)
  policyUrl.pathname = `${url.pathname.replace(/\/$/, '')}/index.html`
  return new Request(policyUrl, request)
}

/**
 * @param {Response} response
 * @returns {Response}
 */
function withJsonContentType(response) {
  const headers = new Headers(response.headers)
  headers.set('content-type', 'application/json')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * @param {Response} response
 * @returns {Response}
 */
function injectBaseTag(response) {
  const HtmlRewriter = /** @type {any} */ (Reflect.get(globalThis, 'HTMLRewriter'))
  return new HtmlRewriter()
    .on('head', {
      /** @param {{ prepend: (html: string, options: { html: boolean }) => void }} element */
      element(element) {
        element.prepend('<base href="/">', { html: true })
      },
    })
    .transform(response)
}

export default {
  /**
   * @param {Request} request
   * @param {AssetsEnv} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url)
    const navigationRequest = wantsHtml(request) && !hasFileExtension(url.pathname)

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const indexResponse = await env.ASSETS.fetch(buildSpaDocumentRequest(request, url))
      return injectBaseTag(indexResponse)
    }

    if (isPolicyDocumentPath(url.pathname)) {
      return env.ASSETS.fetch(buildPolicyDocumentRequest(request, url))
    }

    const assetResponse = await env.ASSETS.fetch(request)
    if (assetResponse.status !== 404 && isAssociationFile(url.pathname)) {
      return withJsonContentType(assetResponse)
    }
    if (assetResponse.status !== 404 || !navigationRequest) {
      return assetResponse
    }

    const indexResponse = await env.ASSETS.fetch(buildSpaDocumentRequest(request, url))
    return injectBaseTag(indexResponse)
  },
}
