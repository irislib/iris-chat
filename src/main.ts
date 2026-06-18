import 'virtual:uno.css'
import './app.css'
import App from './App.svelte'
import { mount } from 'svelte'
import { initServiceWorker } from './swInit'
import { initTheme } from './lib/theme'

initTheme()

// Prevent pinch-to-zoom on iOS
document.addEventListener('gesturestart', (e) => e.preventDefault())
document.addEventListener('gesturechange', (e) => e.preventDefault())
document.addEventListener('gestureend', (e) => e.preventDefault())

// Initialize service worker with auto-update
initServiceWorker()

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
