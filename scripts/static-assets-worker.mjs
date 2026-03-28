function wantsHtml(request) {
  return request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html')
}

function hasFileExtension(pathname) {
  return pathname.split('/').pop()?.includes('.') ?? false
}

function injectBaseTag(response) {
  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.prepend('<base href="/">', { html: true })
      },
    })
    .transform(response)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const navigationRequest = wantsHtml(request) && !hasFileExtension(url.pathname)

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const indexResponse = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request))
      return injectBaseTag(indexResponse)
    }

    const assetResponse = await env.ASSETS.fetch(request)
    if (assetResponse.status !== 404 || !navigationRequest) {
      return assetResponse
    }

    const indexResponse = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request))
    return injectBaseTag(indexResponse)
  },
}
