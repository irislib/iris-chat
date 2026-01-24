<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import jsQR from 'jsqr'

  interface Props {
    onresult: (data: string) => void
  }

  let { onresult }: Props = $props()

  let videoRef = $state<HTMLVideoElement | null>(null)
  let canvasRef = $state<HTMLCanvasElement | null>(null)
  let stream = $state<MediaStream | null>(null)
  let animationId = $state<number | null>(null)
  let error = $state('')

  onMount(() => {
    startCamera()
  })

  onDestroy(() => {
    stopCamera()
  })

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      error = 'Camera not supported in this browser'
      return
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })

      if (videoRef) {
        videoRef.srcObject = stream
        videoRef.play()
        scanFrame()
      }
    } catch (e) {
      error = 'Unable to access camera. Please grant camera permissions.'
      console.error('Camera error:', e)
    }
  }

  function stopCamera() {
    if (animationId) {
      cancelAnimationFrame(animationId)
      animationId = null
    }
    if (stream) {
      stream.getTracks().forEach(track => track.stop())
      stream = null
    }
  }

  function scanFrame() {
    if (!videoRef || !canvasRef) return

    const video = videoRef
    const canvas = canvasRef
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    if (!ctx || video.readyState !== video.HAVE_ENOUGH_DATA) {
      animationId = requestAnimationFrame(scanFrame)
      return
    }

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert',
    })

    if (code) {
      stopCamera()
      onresult(code.data)
      return
    }

    animationId = requestAnimationFrame(scanFrame)
  }
</script>

<div class="w-full h-full relative bg-black">
  {#if error}
    <div class="absolute inset-0 flex items-center justify-center p-4">
      <p class="text-red-400 text-center">{error}</p>
    </div>
  {:else}
    <video
      bind:this={videoRef}
      class="w-full h-full object-cover"
      playsinline
      muted
    ></video>
    <canvas bind:this={canvasRef} class="hidden"></canvas>

    <!-- Scanning overlay -->
    <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div class="w-48 h-48 border-2 border-primary rounded-lg"></div>
    </div>
  {/if}
</div>
