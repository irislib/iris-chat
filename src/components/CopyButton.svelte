<script lang="ts">
  interface Props {
    text: string
    label?: string
    maxLength?: number
  }

  let { text, label, maxLength = 32 }: Props = $props()

  let copied = $state(false)

  function truncateMiddle(str: string, max: number): string {
    if (str.length <= max) return str
    const halfLength = Math.floor((max - 3) / 2)
    return str.slice(0, halfLength) + '...' + str.slice(-halfLength)
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      copied = true
      setTimeout(() => copied = false, 2000)
    } catch (e) {
      console.error('Failed to copy:', e)
    }
  }
</script>

<button
  class="btn-secondary flex-1 min-w-0 flex items-center justify-center gap-2 text-sm py-2 {label ? '' : 'font-mono'} overflow-hidden relative"
  onclick={handleCopy}
  title={text}
>
  <!-- Copied state (overlays when active) -->
  <span class="absolute inset-0 flex items-center justify-center gap-2 transition-opacity {copied ? 'opacity-100' : 'opacity-0 pointer-events-none'}">
    <span class="i-carbon-checkmark flex-shrink-0"></span>
    <span>Copied</span>
  </span>
  <!-- Default state (maintains button width) -->
  <span class="flex items-center justify-center gap-2 transition-opacity {copied ? 'opacity-0' : 'opacity-100'}">
    <span class="i-carbon-copy flex-shrink-0"></span>
    <span class="truncate">{label || truncateMiddle(text, maxLength)}</span>
  </span>
</button>
