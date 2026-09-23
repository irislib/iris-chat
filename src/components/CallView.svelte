<script lang="ts">
  import { onDestroy } from 'svelte'
  import { callState, callError, localCallStream, remoteCallVideo, answerCall, endCall, dismissCall, toggleCallMute, toggleCallCamera } from '../lib/calls'
  import { callSettings } from '../lib/callSettings'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  let localVideo = $state<HTMLVideoElement>()
  let now = $state(Date.now())
  let answering = $state(false)
  const timer = setInterval(() => { now = Date.now() }, 1000)
  onDestroy(() => clearInterval(timer))
  $effect(() => { if (localVideo) { localVideo.srcObject = $localCallStream; void localVideo.play().catch(() => {}) } })
  let elapsed = $derived($callState?.connected ? Math.max(0, Math.floor((now - $callState.connected) / 1000)) : 0)
  let duration = $derived(`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`)
  async function answer(video: boolean) { if (answering) return; answering = true; try { await answerCall(video) } finally { answering = false } }
</script>

{#if $callState}
  <div class="call-screen" role="dialog" tabindex="-1" aria-modal="true" aria-label={$callState.video ? 'Video call' : 'Voice call'} data-testid="call-screen" data-status={$callState.status} data-audio-frames={$callState.receivedAudio} data-video-frames={$callState.receivedVideo}>
    {#if $callState.status === 'active' && $callState.remoteVideo && $remoteCallVideo}
      <img class="remote-video" src={$remoteCallVideo} alt="Caller video" />
    {/if}
    <div class="call-person">
      {#if !$remoteCallVideo || !$callState.remoteVideo || $callState.status !== 'active'}<Avatar pubkey={$callState.owner} size={96} />{/if}
      <h1><Name pubkey={$callState.owner} /></h1>
      <p aria-live="polite">
        {#if $callState.status === 'ended'}{$callState.reason}
        {:else if $callState.status === 'active'}{duration}{#if $callState.remoteMuted} · Muted{/if}
        {:else if $callState.direction === 'incoming'}Incoming {$callState.video ? 'video' : 'voice'} call
        {:else}Calling…{/if}
      </p>
      {#if $callError}<p class="call-error" role="alert">{$callError}</p>{/if}
    </div>
    {#if $callState.camera && $localCallStream && $callState.status !== 'ended'}
      <video class="local-video" bind:this={localVideo} muted autoplay playsinline aria-label="Your camera"></video>
    {/if}
    <div class="call-controls">
      {#if $callState.status === 'ended'}
        <button class="done" onclick={dismissCall}>Done</button>
      {:else if $callState.direction === 'incoming' && $callState.status === 'ringing'}
        <div><button class="round decline" aria-label="Decline call" onclick={endCall}><span class="i-carbon-phone-off-filled"></span></button><span>Decline</span></div>
        {#if $callSettings.voice}
          <div><button class="round answer" aria-label={$callState.video ? 'Answer with voice' : 'Answer call'} disabled={answering} onclick={() => answer(false)}><span class="i-carbon-phone-filled"></span></button><span>{$callState.video ? 'Voice' : 'Answer'}</span></div>
        {/if}
        {#if $callState.video && $callSettings.video}
          <div><button class="round answer" aria-label="Answer with video" disabled={answering} onclick={() => answer(true)}><span class="i-carbon-video-filled"></span></button><span>Video</span></div>
        {/if}
      {:else}
        <div><button class:off={$callState.muted} class="round" aria-label={$callState.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={$callState.muted} onclick={toggleCallMute}><span class={$callState.muted ? 'i-carbon-microphone-off-filled' : 'i-carbon-microphone-filled'}></span></button><span>{$callState.muted ? 'Unmute' : 'Mute'}</span></div>
        {#if $callState.video}
          <div><button class:off={!$callState.camera} class="round" aria-label={$callState.camera ? 'Turn camera off' : 'Turn camera on'} aria-pressed={!$callState.camera} onclick={toggleCallCamera}><span class={$callState.camera ? 'i-carbon-video-filled' : 'i-carbon-video-off-filled'}></span></button><span>Camera</span></div>
        {/if}
        <div><button class="round decline" aria-label="End call" onclick={endCall}><span class="i-carbon-phone-off-filled"></span></button><span>End</span></div>
      {/if}
    </div>
  </div>
{:else if $callError}
  <div class="call-toast" role="alert"><span>{$callError}</span><button aria-label="Dismiss call error" onclick={dismissCall}>×</button></div>
{/if}

<style>
  .call-screen { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: space-between; color: white; background: #172328; padding: max(48px, env(safe-area-inset-top)) 24px max(48px, env(safe-area-inset-bottom)); }
  .call-person { display: flex; flex-direction: column; align-items: center; gap: 12px; z-index: 1; margin-top: 6vh; text-align: center; text-shadow: 0 1px 12px #0008; }
  h1 { font-size: 28px; font-weight: 600; }
  p { color: #d2dde2; }
  .call-error { max-width: 360px; color: #ffd0cc; font-size: 14px; }
  .call-controls { display: flex; align-items: center; justify-content: center; gap: 28px; z-index: 2; }
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
  .local-video { position: absolute; top: 24px; right: 24px; width: min(28vw, 180px); border-radius: 14px; transform: scaleX(-1); box-shadow: 0 2px 20px #0005; }
  .done { background: #ffffff20; border-radius: 24px; padding: 12px 40px; }
  .call-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 100; display: flex; gap: 16px; align-items: center; background: #3f2020; color: white; padding: 16px 20px; border-radius: 16px; max-width: 90vw; }
  @media (max-width: 500px) { .call-person { margin-top: 15vh; } .call-controls { gap: 24px; } }
</style>
