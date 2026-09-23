<script lang="ts">
  import { callHistoryLabel, formatCallDuration, type CallHistory } from '../lib/callHistory'
  let { call }: { call: CallHistory } = $props()
  let missed = $derived(!call.inProgress && call.outcome === 'missed')
  let label = $derived(callHistoryLabel(call))
</script>

<div class="flex justify-center py-3" data-testid="call-history-row" data-call-id={call.callId} data-outcome={call.outcome}>
  <div class="flex items-center gap-2 text-sm" class:missed class:text-red-400={missed} class:text-gray-400={!missed}>
    <span class={call.video ? 'i-carbon-video-filled text-base' : 'i-carbon-phone-filled text-base'} aria-hidden="true"></span>
    <div>
      <div>{label}</div>
      <div class="flex items-center justify-center gap-1 text-xs text-gray-500 mt-0.5">
        <span class={call.direction === 'incoming' ? 'i-carbon-arrow-down-left' : 'i-carbon-arrow-up-right'} aria-hidden="true"></span>
        <time datetime={new Date(call.startedAt).toISOString()}>{new Date(call.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        {#if call.outcome === 'answered' && !call.inProgress}
          <span aria-hidden="true">·</span>
          <span>{formatCallDuration(call.durationSeconds)}</span>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  :global(html[data-theme='light']) .missed { color: #b91c1c; }
</style>
