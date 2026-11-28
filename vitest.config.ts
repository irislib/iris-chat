import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte({ hot: !process.env.VITEST })],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/testSetup.ts'],
    include: ['src/**/*.{test,spec}.{js,ts}'],
  },
})
