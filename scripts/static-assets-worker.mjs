import { buildSpaDocumentRequest } from './static-assets-worker-lib.mjs'

/**
 * @param {Request} request
 * @returns {string}
 */
function forwardedScheme(request) {
  const forwardedProto = request.headers.get('x-forwarded-proto')
  if (forwardedProto) return forwardedProto.toLowerCase()

  const visitor = request.headers.get('cf-visitor')
  if (!visitor) return ''
  try {
    const parsed = JSON.parse(visitor)
    return typeof parsed.scheme === 'string' ? parsed.scheme.toLowerCase() : ''
  } catch {
    return ''
  }
}

/**
 * @param {Request} request
 * @param {URL} url
 * @returns {boolean}
 */
function shouldRedirectToHttps(request, url) {
  const scheme = forwardedScheme(request)
  const cf = /** @type {{ cf?: { tlsVersion?: string } }} */ (
    /** @type {unknown} */ (request)
  ).cf
  if (cf && !cf.tlsVersion) return true
  return scheme === 'http' || (!scheme && url.protocol === 'http:')
}

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
 * @param {string} pathname
 * @returns {'privacy' | 'terms' | 'csae' | null}
 */
function policyDocumentSlug(pathname) {
  const slug = pathname.replace(/^\/+|\/+$/g, '')
  return slug === 'privacy' || slug === 'terms' || slug === 'csae' ? slug : null
}

const policyStyles = 'body{max-width:40rem;margin:3rem auto;padding:0 1.5rem;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222}h1{font-size:1.6rem}h2{font-size:1.1rem;margin-top:2rem}a{color:#5a3eb6}'

const policyBodies = {
  privacy: `
  <h1>Privacy Policy</h1>
  <p>Last updated: 15 May 2026</p>
  <h2>What we collect</h2>
  <p>Iris Chat does not ask for your name, email, or phone number. Your identity is a keypair generated on your device. We do not maintain user accounts.</p>
  <h2>What stays on your device</h2>
  <p>Your secret key, contacts, group memberships, and message history are stored locally on the devices you use Iris Chat on. They are not uploaded to a central Iris Chat server.</p>
  <h2>What goes to the Nostr network</h2>
  <p>To deliver messages, Iris Chat publishes encrypted events to message servers you choose. Direct messages are wrapped with rotating keys that change per message, so server operators do not see message contents. They may still see encrypted payloads, connection details, and timing metadata. If you publish a public profile such as a display name or picture, that profile is visible under your public key.</p>
  <h2>Push notifications</h2>
  <p>If you enable notifications, your device's push notification token is sent to a notification service so messages addressed to you can wake the app. The service sees only encrypted payloads, never message contents.</p>
  <h2>No tracking, no analytics</h2>
  <p>Iris Chat does not include third-party analytics, advertising SDKs, or behavioural tracking.</p>
  <h2>Your data, your control</h2>
  <p>You can erase local data in the app or by uninstalling it. Where supported, Delete profile clears your public profile before removing local data. Independent message servers may keep previously delivered events according to their own policies.</p>
  <h2>Contact</h2>
  <p>Questions: <a href="mailto:irismessenger@pm.me">irismessenger@pm.me</a></p>`,
  terms: `
  <h1>Terms of Use</h1>
  <p>Last updated: 15 May 2026</p>
  <h2>Using Iris Chat</h2>
  <p>Iris Chat is open source messaging software. By using it, you agree to use it lawfully and to respect other people.</p>
  <h2>Your responsibility</h2>
  <p>You are responsible for your messages, profile, devices, secret keys, backups, and the message servers you choose to use. Keep your secret key private. If you lose it, we cannot recover it for you.</p>
  <h2>Decentralized message delivery</h2>
  <p>Iris Chat connects to independent message servers. We do not control every server, guarantee delivery, or guarantee that a server will delete data after receiving a deletion request.</p>
  <h2>Safety</h2>
  <p>Do not use Iris Chat to harass, threaten, exploit, impersonate, distribute illegal content, or violate anyone's rights. You can block users in the app and report concerns to us.</p>
  <h2>No warranty</h2>
  <p>Iris Chat is provided as is, without warranties of any kind. Use it at your own risk. We are not liable for lost data, missed messages, service interruptions, or other damages from using the software.</p>
  <h2>Changes</h2>
  <p>We may update these terms. Continued use of Iris Chat after an update means you accept the updated terms.</p>
  <h2>Contact</h2>
  <p>Questions: <a href="mailto:irismessenger@pm.me">irismessenger@pm.me</a></p>`,
  csae: `
  <h1>Child Safety Standards</h1>
  <p>Last updated: 15 May 2026</p>
  <h2>Our commitment</h2>
  <p>Iris Chat has zero tolerance for child sexual abuse material, grooming, exploitation, or attempts to harm children.</p>
  <h2>What users can do</h2>
  <p>Users can block abusive users, reject unwanted chat requests, and report safety concerns from direct chat profiles in the iOS app. Reports can also be sent by email.</p>
  <h2>Decentralized network</h2>
  <p>Iris Chat is a client for decentralized messaging. Messages may be delivered through independent third-party message servers that we do not operate. We do not host user message history on a central Iris Chat server.</p>
  <h2>Reporting illegal content</h2>
  <p>If you encounter child sexual abuse material or suspect child exploitation, report it immediately to the appropriate authority:</p>
  <ul>
    <li>United States: <a href="https://report.cybertip.org">NCMEC CyberTipline</a></li>
    <li>International: <a href="https://www.iwf.org.uk">Internet Watch Foundation</a></li>
    <li>Emergency: contact local law enforcement</li>
  </ul>
  <h2>Contact</h2>
  <p>Child safety concerns: <a href="mailto:irismessenger@pm.me">irismessenger@pm.me</a></p>`,
}

/**
 * @param {'privacy' | 'terms' | 'csae'} slug
 * @returns {Response}
 */
function policyDocumentResponse(slug) {
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Iris Chat</title>
  <style>${policyStyles}</style>
</head>
<body>${policyBodies[slug]}
</body>
</html>`
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  })
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
    if (shouldRedirectToHttps(request, url)) {
      url.protocol = 'https:'
      url.port = ''
      return Response.redirect(url.toString(), 308)
    }

    const navigationRequest = wantsHtml(request) && !hasFileExtension(url.pathname)

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const indexResponse = await env.ASSETS.fetch(buildSpaDocumentRequest(request, url))
      return injectBaseTag(indexResponse)
    }

    if (isPolicyDocumentPath(url.pathname)) {
      const slug = policyDocumentSlug(url.pathname)
      if (slug) {
        return policyDocumentResponse(slug)
      }
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
