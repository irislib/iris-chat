<script lang="ts">
  import { EXPIRATION_OPTIONS, getExpirationLabel } from '../lib/expiration'

  interface Props {
    currentTtlSeconds: number | null | undefined
    onclose: () => void
    onselect: (ttlSeconds: number | null) => void
  }

  let { currentTtlSeconds, onclose, onselect }: Props = $props()

  function handleSelect(value: number | null) {
    onselect(value)
    onclose()
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
  role="dialog"
  aria-modal="true"
>
  <button
    class="absolute inset-0 cursor-default border-none bg-transparent"
    onclick={onclose}
    aria-label="Close modal"
  ></button>

  <div class="bg-surface rounded-2xl p-6 max-w-sm w-full relative z-10">
    <div class="flex justify-between items-center mb-4">
      <h3 class="text-lg font-semibold text-white">Disappearing messages</h3>
      <button
        class="btn-ghost p-2"
        onclick={onclose}
        aria-label="Close"
      >
        <span class="i-carbon-close text-xl"></span>
      </button>
    </div>

    <p class="text-sm text-gray-400 mb-4">
      Messages will be deleted after the selected time.
    </p>

    <div class="flex flex-col gap-1">
      <button
        class="w-full text-left px-4 py-3 rounded-lg hover:bg-surface-light transition-colors flex items-center justify-between"
        onclick={() => handleSelect(null)}
      >
        <span class="text-sm">Off</span>
        {#if currentTtlSeconds === null || currentTtlSeconds === undefined}
          <span class="i-carbon-checkmark text-primary"></span>
        {/if}
      </button>

      {#each EXPIRATION_OPTIONS as option}
        <button
          class="w-full text-left px-4 py-3 rounded-lg hover:bg-surface-light transition-colors flex items-center justify-between"
          onclick={() => handleSelect(option.value)}
        >
          <span class="text-sm">{option.label}</span>
          {#if currentTtlSeconds === option.value}
            <span class="i-carbon-checkmark text-primary"></span>
          {/if}
        </button>
      {/each}
    </div>
  </div>
</div>
