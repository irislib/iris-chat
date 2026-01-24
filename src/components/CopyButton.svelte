<script lang="ts">
  interface Props {
    text: string
    maxLength?: number
  }

  let { text, maxLength = 32 }: Props = $props()

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
  class="btn-secondary flex-1 min-w-0 flex items-center justify-center gap-2 text-sm py-2 font-mono overflow-hidden"
  onclick={handleCopy}
  title={text}
>
  {#if copied}
    <span class="i-carbon-checkmark flex-shrink-0"></span>
    <span>Copied</span>
  {:else}
    <span class="i-carbon-copy flex-shrink-0"></span>
    <span class="truncate">{truncateMiddle(text, maxLength)}</span>
  {/if}
</button>
