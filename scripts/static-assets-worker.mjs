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
  <p>Last updated: 20 October 2026</p>

  <h2>Your identity and devices</h2>
  <p>Iris Chat does not require a phone number or email address. Your identity starts with a secret key generated on your device and a public user ID. Your secret key and readable message history stay on your devices. Linked devices receive the information needed to use your identity and sync conversations through encrypted connections.</p>

  <h2>Private messages and files</h2>
  <p>Direct and group messages are end-to-end encrypted. Message servers carry and may retain encrypted messages, but do not receive the keys needed to read them. Photos, videos, and files shared in private chats are encrypted before upload; their download links and decryption keys are shared inside the encrypted conversation. File servers may retain the encrypted files.</p>
  <p>Your recipients and linked devices can read and copy the content you share with them. Anyone you give a file's decryption link to can read that file. If you chat with an agent, any service the agent forwards your messages to has its own privacy practices.</p>

  <h2>Public profiles and follows</h2>
  <p>Your public user ID and the public IDs of linked devices are published to message servers. If you add a profile name, picture, or bio, it is published with your user ID. Profile pictures are publicly readable through the link in your profile; they are not private chat attachments.</p>
  <p>If you use public follows, the people you follow are published with your user ID. This public list is separate from your private chats. Public profiles and follow lists can be read, copied, and retained by other people and services.</p>

  <h2>Notifications and connection information</h2>
  <p>When you enable mobile notifications, the notification service receives your device's push token and filters identifying the message or call events your device needs. Registration is authenticated with your user ID, so the service can associate that ID with the token and filters. It forwards encrypted message events and call notifications without receiving your private message decryption keys.</p>
  <p>Apple or Google also processes push delivery through its notification service. Message servers, file servers, notification services, and directly connected peers can observe connection information such as IP addresses, request times, and traffic size. Encryption does not hide all connection or delivery metadata. These services have their own retention policies.</p>

  <h2>No advertising or tracking</h2>
  <p>Iris Chat does not include third-party analytics, advertising SDKs, or behavioural tracking. Public profile information and notification identifiers support app functionality; they are not used for advertising or tracking across other companies' apps and websites.</p>

  <h2>Support and reports</h2>
  <p>If you contact us or send a report, we receive your contact details and the information you choose to include. The iOS report action opens an email draft with the reported user's name and user ID and your app version; it does not automatically attach your chat history. Review what you send and never include your secret key.</p>

  <h2>Your choices and deletion</h2>
  <p>You can choose your message servers, manage notification permissions, remove linked devices, and erase local data. Deleting local data does not erase copies held by recipients, other devices, or network services. Where supported, Delete profile publishes a request to clear your public profile before removing local data; it cannot guarantee removal of previously copied information. Contact the operator of a service about information it retains.</p>

  <h2>Contact</h2>
  <p>Iris Chat is provided by Sirius Business Oy. Privacy questions: <a href="mailto:irismessenger@pm.me">irismessenger@pm.me</a></p>`,
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
