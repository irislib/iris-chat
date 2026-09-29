<script lang="ts">
  import { onDestroy } from 'svelte'
  import { callState, callError, callMediaStats, localCallStream, remoteCallVideo, answerCall, endCall, dismissCall, toggleCallMute, toggleCallCamera, callScreenSharing, toggleCallScreenShare } from '../lib/calls'
  import { callSettings } from '../lib/callSettings'
  import CallQualityControls from './CallQualityControls.svelte'
  import CallDeviceControls from './CallDeviceControls.svelte'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  let localVideo = $state<HTMLVideoElement>()
  let remoteVideo = $state<HTMLDivElement>()
  let showQuality = $state(false)
  let qualityCallId = ''
  let now = $state(Date.now())
  let answering = $state(false)
  const canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  const timer = setInterval(() => { now = Date.now() }, 1000)
  onDestroy(() => clearInterval(timer))
  $effect(() => { if (localVideo) { localVideo.srcObject = $localCallStream; void localVideo.play().catch(() => {}) } })
  $effect(() => { if (remoteVideo && $remoteCallVideo) { remoteVideo.replaceChildren($remoteCallVideo) } })
  $effect(() => { const id = $callState?.id ?? ''; if (id !== qualityCallId) { qualityCallId = id; showQuality = false } })
  let elapsed = $derived($callState?.connected ? Math.max(0, Math.floor((now - $callState.connected) / 1000)) : 0)
  let duration = $derived(`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`)
  async function answer(video: boolean) { if (answering) return; answering = true; try { await answerCall(video) } finally { answering = false } }
</script>

{#if $callState}
  <div class="call-screen" role="dialog" tabindex="-1" aria-modal="true" aria-label={$callState.video ? 'Video call' : 'Voice call'} data-testid="call-screen" data-status={$callState.status} data-audio-energy={$callMediaStats?.audioEnergy ?? 0} data-target-bitrate={$callMediaStats?.targetBitrate ?? 0} data-sent-bytes={$callMediaStats?.sentBytes ?? 0} data-audio-frames={$callState.receivedAudio} data-video-frames={$callState.receivedVideo}>
    {#if $remoteCallVideo && $callState.status !== 'ended'}
      <div class="remote-video" class:audio-only={!$callState.remoteVideo} bind:this={remoteVideo} aria-label="Caller video"></div>
    {/if}
    <div class="call-person">
      {#if !$remoteCallVideo || !$callState.remoteVideo || $callState.status !== 'active'}<Avatar pubkey={$callState.owner} size={96} />{/if}
      <h1><Name pubkey={$callState.owner} /></h1>
      <p aria-live="polite">
        {#if $callState.status === 'ended'}{$callState.reason}
        {:else if $callState.status === 'active'}{duration}{#if $callState.remoteMuted} · Muted{/if}
        {:else if $callState.status === 'connecting'}Connecting…
        {:else if $callState.direction === 'incoming'}Incoming {$callState.video ? 'video' : 'voice'} call
        {:else}Calling…{/if}
      </p>
      {#if $callScreenSharing.active}<p class="sharing-status" role="status">Sharing your screen</p>{/if}
      {#if $callError}<p class="call-error" role="alert">{$callError}</p>{/if}
    </div>
    {#if $callState.camera && $localCallStream && $callState.status !== 'ended'}
      <video class="local-video" class:screen-preview={$callScreenSharing.active} bind:this={localVideo} muted autoplay playsinline aria-label={$callScreenSharing.active ? 'Your screen' : 'Your camera'}></video>
    {/if}
    {#if showQuality && $callState.status !== 'ended'}
      <div class="quality-panel" role="region" aria-label="Call settings">
        <CallDeviceControls />
        {#if $callState.video}<div class="quality-options"><CallQualityControls /></div>{/if}
      </div>
    {/if}
    <div class="call-controls">
      {#if $callState.status === 'ended'}
        <button class="done" onclick={dismissCall}>Done</button>
      {:else if $callState.direction === 'incoming' && $callState.status === 'ringing'}
        <div><button class="round decline" title="Decline call" aria-label="Decline call" onclick={endCall}><span class="i-carbon-phone-off-filled"></span></button><span>Decline</span></div>
        {#if $callSettings.voice}
          <div><button class="round answer" title={$callState.video ? 'Answer with voice' : 'Answer call'} aria-label={$callState.video ? 'Answer with voice' : 'Answer call'} disabled={answering} onclick={() => answer(false)}><span class="i-carbon-phone-filled"></span></button><span>{$callState.video ? 'Voice' : 'Answer'}</span></div>
        {/if}
        {#if $callState.video && $callSettings.video}
          <div><button class="round answer" title="Answer with video" aria-label="Answer with video" disabled={answering} onclick={() => answer(true)}><span class="i-carbon-video-filled"></span></button><span>Video</span></div>
        {/if}
      {:else}
        <div><button class:off={$callState.muted} class="round" title={$callState.muted ? 'Unmute microphone' : 'Mute microphone'} aria-label={$callState.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={$callState.muted} onclick={toggleCallMute}><span class={$callState.muted ? 'i-carbon-microphone-off-filled' : 'i-carbon-microphone-filled'}></span></button><span>{$callState.muted ? 'Unmute' : 'Mute'}</span></div>
        {#if $callState.video}
          <div><button disabled={$callScreenSharing.active || $callScreenSharing.pending} class:off={!$callState.camera || $callScreenSharing.active} class="round" title={$callScreenSharing.active ? 'Stop sharing to use the camera' : $callState.camera ? 'Turn camera off' : 'Turn camera on'} aria-label={$callScreenSharing.active ? 'Stop sharing to use the camera' : $callState.camera ? 'Turn camera off' : 'Turn camera on'} aria-pressed={!$callState.camera || $callScreenSharing.active} onclick={toggleCallCamera}><span class={$callState.camera && !$callScreenSharing.active ? 'i-carbon-video-filled' : 'i-carbon-video-off-filled'}></span></button><span>Camera</span></div>
        {/if}
        {#if canShareScreen && $callState.video && $callState.status === 'active'}
          <div><button class="round" class:off={$callScreenSharing.active} title={$callScreenSharing.active ? 'Stop sharing' : 'Share screen'} aria-label={$callScreenSharing.active ? 'Stop sharing' : 'Share screen'} aria-pressed={$callScreenSharing.active} disabled={$callScreenSharing.pending} onclick={toggleCallScreenShare}><span class="i-carbon-screen"></span></button><span>{$callScreenSharing.active ? 'Stop sharing' : $callScreenSharing.pending ? 'Choose screen…' : 'Share screen'}</span></div>
        {/if}
        <div><button class="round" title="Call settings" aria-label="Call settings" aria-expanded={showQuality} onclick={() => showQuality = !showQuality}><span class="i-carbon-settings"></span></button><span>Settings</span></div>
        <div><button class="round decline" title="End call" aria-label="End call" onclick={endCall}><span class="i-carbon-phone-off-filled"></span></button><span>End</span></div>
      {/if}
    </div>
  </div>
{:else if $callError}
  <div class="call-toast" role="alert"><span>{$callError}</span><button title="Dismiss call error" aria-label="Dismiss call error" onclick={dismissCall}>×</button></div>
{/if}

<style>
  .call-screen { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: space-between; color: white; background: #172328; padding: max(48px, env(safe-area-inset-top)) 24px max(48px, env(safe-area-inset-bottom)); }
  .call-person { display: flex; flex-direction: column; align-items: center; gap: 12px; z-index: 1; margin-top: 6vh; text-align: center; text-shadow: 0 1px 12px #0008; }
  h1 { font-size: 28px; font-weight: 600; }
  p { color: #d2dde2; }
  .call-error { max-width: 360px; color: #ffd0cc; font-size: 14px; }
  .sharing-status { padding: 6px 12px; border-radius: 20px; background: #172328dd; color: white; font-size: 14px; }
  .call-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 28px; z-index: 2; }
  .call-controls > div { display: flex; flex-direction: column; align-items: center; gap: 9px; font-size: 13px; }
  .round { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: #ffffff25; color: white; }
  .round > span { font-size: 26px; }
  .round:hover { filter: brightness(1.16); }
  .round:focus-visible, .done:focus-visible { outline: 3px solid white; outline-offset: 4px; }
  .round.off { background: white; color: #172328; }
  .round.answer { background: #22a66d; }
  .round.decline { background: #e34550; }
  .round:disabled { opacity: .5; }
  .remote-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #101719; }
  .remote-video :global(canvas) { width: 100%; height: 100%; object-fit: contain; }
  .remote-video.audio-only { width: 1px; height: 1px; opacity: 0; }
  .quality-panel { position: absolute; bottom: 170px; z-index: 3; width: min(340px, calc(100vw - 32px)); max-height: calc(100dvh - 200px); overflow-y: auto; padding: 20px; border-radius: 18px; background: #172328f5; }
  .quality-options { margin-top: 20px; }
  .local-video { position: absolute; top: 24px; right: 24px; width: min(28vw, 180px); border-radius: 14px; transform: scaleX(-1); box-shadow: 0 2px 20px #0005; }
  .local-video.screen-preview { transform: none; width: min(36vw, 240px); }
  .done { background: #ffffff20; border-radius: 24px; padding: 12px 40px; }
  .call-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 100; display: flex; gap: 16px; align-items: center; background: #3f2020; color: white; padding: 16px 20px; border-radius: 16px; max-width: 90vw; }
  @media (max-width: 500px) { .call-person { margin-top: 15vh; } .call-controls { gap: 16px; } .round { width: 56px; height: 56px; } }
</style>
