// @vitest-environment node

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

function stripInlineScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
}

function getAttributeValues(html: string, attribute: 'href' | 'src'): string[] {
  return [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map((match) => match[1])
}

async function loadViteConfig() {
  vi.resetModules()
  const configModule = await import('../vite.config')
  return configModule.default
}

describe('portable build config', () => {
  it('uses a relative base for portable static hosting', async () => {
    const config = await loadViteConfig()
    expect(config.base ?? '/').toBe('./')
  })

  it('separates application code from the dependency runtime', async () => {
    const config = await loadViteConfig()
    const output = config.build?.rollupOptions?.output
    const manualChunks = !Array.isArray(output) ? output?.manualChunks : undefined

    expect(manualChunks).toBeTypeOf('function')
    expect(manualChunks?.('/repo/node_modules/@fips/core/dist/index.js', {} as never)).toBe('vendor')
    expect(manualChunks?.('/repo/node_modules/@nostr-dev-kit/ndk/dist/index.js', {} as never)).toBe('vendor')
    expect(manualChunks?.('/repo/node_modules/marked/lib/marked.esm.js', {} as never)).toBe('vendor')
  })

  it('keeps the HTML entrypoint free of root-absolute asset refs', () => {
    const indexHtml = stripInlineScripts(fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8'))

    for (const value of [...getAttributeValues(indexHtml, 'href'), ...getAttributeValues(indexHtml, 'src')]) {
      expect(value).not.toMatch(/^\//)
    }
  })
})
