<script lang="ts">
  import { callSettings, setCallSettings } from '../lib/callSettings'
  import { callQualityOptions, normalizeCallQuality, type CallQuality } from '../lib/callQuality'
</script>
<div class="space-y-3">
  <label class="flex items-center justify-between gap-4 text-sm">
    <span>Call quality</span>
    <select class="input max-w-48" aria-label="Call quality" value={$callSettings.quality ?? 'auto'} onchange={event => setCallSettings({ quality: event.currentTarget.value as CallQuality })}>
      {#each callQualityOptions as option}<option value={option.value}>{option.label}</option>{/each}
    </select>
  </label>
  {#if $callSettings.quality === 'custom'}
    <label class="flex items-center justify-between gap-4 text-sm">
      <span>Video limit (kbps)</span>
      <input class="input w-28" type="number" min="100" max="8000" step="100" aria-label="Video limit (kbps)" value={$callSettings.customBitrateKbps ?? 2000} onchange={event => setCallSettings({ customBitrateKbps: normalizeCallQuality({ customBitrateKbps: Number(event.currentTarget.value) }).customBitrateKbps })} />
    </label>
  {/if}
</div>

<style>
  select, input { color: inherit; background: #ffffff12; border: 1px solid #ffffff30; border-radius: 8px; padding: 8px 10px; }
  option { color: #111; background: white; }
</style>
