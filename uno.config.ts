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
        DEFAULT: '#6366f1',
        dark: '#4f46e5',
      },
      surface: {
        DEFAULT: '#1e1e1e',
        light: '#2d2d2d',
        lighter: '#3d3d3d',
      },
    },
  },
  shortcuts: {
    'btn': 'px-4 py-2 rounded-full font-medium cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed',
    'btn-primary': 'btn bg-primary hover:bg-primary-dark text-white',
    'btn-danger': 'btn bg-red-600 hover:bg-red-700 text-white',
    'btn-secondary': 'btn bg-surface-light hover:bg-surface-lighter text-white',
    'btn-ghost': 'btn bg-surface border border-surface-lighter text-gray-300 hover:bg-surface-light',
    'input-field': 'w-full px-4 py-2 rounded-full bg-surface-light b-1 b-solid b-surface-lighter focus:b-primary outline-none text-white',
  },
})
