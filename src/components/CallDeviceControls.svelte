<script lang="ts">
  import { callDevices, callDeviceError, selectCallDevice } from '../lib/calls'
  import type { CallDeviceKind } from '../lib/callDevices'
  let changing = $state(false)
  async function change(kind: CallDeviceKind, event: Event) {
    const select = event.currentTarget as HTMLSelectElement
    changing = true
    try { await selectCallDevice(kind, select.value) }
    finally { select.value = $callDevices?.[kind] ?? ''; changing = false }
  }
</script>

{#if $callDevices}
  <div class="devices">
    <label>Microphone
      <select value={$callDevices.microphone} disabled={changing} onchange={event => change('microphone', event)}>
        <option value="">System default</option>
        {#each $callDevices.microphones as device}<option value={device.id}>{device.label}</option>{/each}
      </select>
    </label>
    {#if $callDevices.canSelectSpeaker}
      <label>Speaker
        <select value={$callDevices.speaker} disabled={changing} onchange={event => change('speaker', event)}>
          <option value="">System default</option>
          {#each $callDevices.speakers as device}<option value={device.id}>{device.label}</option>{/each}
        </select>
      </label>
    {:else}
      <p>Choose your speaker in your device’s sound settings.</p>
    {/if}
  </div>
{/if}
{#if $callDeviceError}<p class="error" role="alert">{$callDeviceError}</p>{/if}

<style>
  .devices { display: flex; flex-direction: column; gap: 16px; }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
  select { width: 100%; min-width: 0; padding: 10px; border-radius: 8px; background: #28363d; color: white; }
  p { font-size: 13px; color: #d2dde2; }
  .error { color: #ffd0cc; }
</style>
