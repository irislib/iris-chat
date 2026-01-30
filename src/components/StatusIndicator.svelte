<script lang="ts">
  interface Props {
    status?: string
    variant?: 'bubble' | 'dark'
  }

  let { status, variant = 'dark' }: Props = $props()

  let checkColor = $derived(
    status === 'seen'
      ? (variant === 'bubble' ? 'text-[#7dd3fc]' : 'text-primary')
      : (variant === 'bubble' ? 'text-white/60' : 'text-gray-500')
  )
  let outlineColor = $derived(variant === 'bubble' ? 'text-[#6366f1]' : 'text-[#0a0a0a]')
</script>

{#if status === 'seen' || status === 'delivered'}
  <span class="relative inline-block w-4 h-3 flex-shrink-0">
    <span class="i-carbon-checkmark text-xs absolute top-0 left-0 {checkColor}"></span>
    <span class="i-carbon-checkmark absolute top-0 left-[5px] {outlineColor} check-outline-size"></span>
    <span class="i-carbon-checkmark text-xs absolute top-0 left-[5px] {checkColor}"></span>
  </span>
{:else if status}
  <span class="relative inline-block w-4 h-3 {variant === 'bubble' ? 'text-white/60' : 'text-gray-500'} flex-shrink-0">
    <span class="i-carbon-checkmark text-xs absolute top-0 left-[5px]"></span>
  </span>
{/if}

<style>
  .check-outline-size {
    font-size: 14px;
    margin-top: -1px;
    margin-left: -1px;
  }
</style>
