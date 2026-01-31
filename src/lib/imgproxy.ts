export interface ImgProxyConfig {
  url: string
  key: string
  salt: string
}

export interface ImgProxyOptions {
  width?: number
  height?: number
  square?: boolean
}

export const DEFAULT_IMGPROXY_CONFIG: ImgProxyConfig = {
  url: 'https://imgproxy.iris.to',
  key: 'f66233cb160ea07078ff28099bfa3e3e654bc10aa4a745e12176c433d79b8996',
  salt: '5e608e60945dcd2a787e8465d76ba34149894765061d39287609fb9d776caa0c',
}

function urlSafeBase64(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join('')
  return btoa(binString).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function concatBytes(...arrays: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

async function signUrl(path: string, key: string, salt: string): Promise<string> {
  const te = new TextEncoder()
  const data = concatBytes(hexToBytes(salt), te.encode(path))

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data)
  return urlSafeBase64(new Uint8Array(signature))
}

export async function generateProxyUrl(
  originalSrc: string,
  options: ImgProxyOptions = {},
  config: ImgProxyConfig = DEFAULT_IMGPROXY_CONFIG
): Promise<string> {
  try {
    if (
      originalSrc.startsWith(config.url) ||
      originalSrc.startsWith('data:') ||
      originalSrc.startsWith('blob:')
    ) {
      return originalSrc
    }

    try { new URL(originalSrc) } catch { return originalSrc }

    const te = new TextEncoder()
    const encodedUrl = urlSafeBase64(te.encode(originalSrc))

    const opts: string[] = []
    if (options.width || options.height) {
      const resizeType = options.square ? 'fill' : 'fit'
      const w = options.width || options.height!
      const h = options.height || options.width!
      opts.push(`rs:${resizeType}:${w}:${h}`)
    }
    opts.push('dpr:2')

    const path = `/${opts.join('/')}/${encodedUrl}`
    const signature = await signUrl(path, config.key, config.salt)
    return `${config.url}/${signature}${path}`
  } catch {
    return originalSrc
  }
}
