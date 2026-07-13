import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import UnoCSS from 'unocss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  base: './',
  // The pinned Git package omits a generated module; bundle its complete source tree.
  resolve: { alias: { '@fips/core': fileURLToPath(new URL('./node_modules/@fips/core/src/index.ts', import.meta.url)) } },
  plugins: [
    UnoCSS(),
    svelte(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.ts',
      registerType: 'autoUpdate',
      injectManifest: {
        injectionPoint: undefined
      },
      devOptions: {
        enabled: true,
        type: 'module'
      },
      manifest: false // We use our own manifest.json
    })
  ],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.npm_package_version),
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(new Date().toISOString()),
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      onwarn(warning: any, warn: any) {
        if (warning.code === 'EVAL' && warning.id?.includes('tseep')) return
        warn(warning)
      },
    },
  },
  server: {
    allowedHosts: ['mayhem2.iris.to'],
  },
})
