import { defineConfig, presetUno, presetIcons } from 'unocss'
import transformerDirectives from '@unocss/transformer-directives'

export default defineConfig({
  presets: [
    presetUno(),
    presetIcons({
      scale: 1.2,
      extraProperties: {
        'display': 'inline-block',
        'vertical-align': 'middle',
      },
    }),
  ],
  transformers: [
    transformerDirectives(),
  ],
  theme: {
    colors: {
      primary: {
        DEFAULT: 'rgb(var(--color-primary) / <alpha-value>)',
        dark: 'rgb(var(--color-primary-dark) / <alpha-value>)',
      },
      app: 'rgb(var(--color-bg) / <alpha-value>)',
      panel: 'rgb(var(--color-panel) / <alpha-value>)',
      surface: {
        DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
        light: 'rgb(var(--color-surface-light) / <alpha-value>)',
        lighter: 'rgb(var(--color-surface-lighter) / <alpha-value>)',
      },
      control: {
        DEFAULT: 'rgb(var(--color-control) / <alpha-value>)',
        hover: 'rgb(var(--color-control-hover) / <alpha-value>)',
      },
      apptext: 'rgb(var(--color-text) / <alpha-value>)',
      muted: 'rgb(var(--color-muted) / <alpha-value>)',
    },
  },
  shortcuts: {
    'btn': 'px-4 py-2 rounded-full font-medium cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed',
    'btn-primary': 'btn bg-primary hover:bg-primary-dark text-white',
    'btn-danger': 'btn bg-red-600 hover:bg-red-700 text-white',
    'btn-secondary': 'btn bg-control hover:bg-control-hover border border-surface-lighter shadow-sm text-apptext',
    'btn-ghost': 'btn bg-surface border border-surface-lighter text-muted hover:bg-surface-light',
    'input-field': 'w-full px-4 py-2 rounded-full bg-surface-light b-1 b-solid b-surface-lighter focus:b-primary outline-none text-apptext',
  },
})
