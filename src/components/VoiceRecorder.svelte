<script lang="ts">
  import { onMount, onDestroy } from 'svelte'

  interface Props {
    onrecorded: (file: File) => void
    oncancel: () => void
    disabled?: boolean
  }

  let { onrecorded, oncancel, disabled = false }: Props = $props()

  let mediaRecorder: MediaRecorder | null = $state(null)
  let audioChunks: Blob[] = $state([])
  let isRecording = $state(false)
  let recordingTime = $state(0)
  let timerInterval: ReturnType<typeof setInterval> | null = null

  // Auto-start recording on mount
  onMount(() => {
    startRecording()
  })

  onDestroy(() => {
    cleanup()
  })

  function cleanup() {
    if (timerInterval) {
      clearInterval(timerInterval)
      timerInterval = null
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stream.getTracks().forEach(track => track.stop())
      mediaRecorder.stop()
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      // Choose best supported format
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4'

      mediaRecorder = new MediaRecorder(stream, { mimeType })
      audioChunks = []
      recordingTime = 0

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunks.push(e.data)
        }
      }

      mediaRecorder.start()
      isRecording = true

      // Start timer
      timerInterval = setInterval(() => {
        recordingTime++
      }, 1000)
    } catch (e) {
      console.error('Failed to start recording:', e)
      alert('Could not access microphone. Please check permissions.')
      oncancel()
    }
  }

  function stopAndSend() {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') return

    mediaRecorder.onstop = () => {
      mediaRecorder!.stream.getTracks().forEach(track => track.stop())
      if (timerInterval) {
        clearInterval(timerInterval)
        timerInterval = null
      }

      // Create File from recorded chunks
      const mimeType = mediaRecorder!.mimeType
      const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'm4a' : 'ogg'
      const blob = new Blob(audioChunks, { type: mimeType })
      const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mimeType })

      onrecorded(file)
    }

    mediaRecorder.stop()
  }

  function cancel() {
    cleanup()
    isRecording = false
    oncancel()
  }

  function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }
</script>

{#if isRecording}
  <!-- Recording UI -->
  <div class="flex items-center gap-2 flex-1">
    <button
      class="w-11 h-11 p-0 flex items-center justify-center flex-shrink-0 text-red-400 hover:text-red-300 hover:bg-surface-light rounded-full transition-colors"
      onclick={cancel}
      aria-label="Cancel recording"
    >
      <span class="i-carbon-close text-xl"></span>
    </button>

    <div class="flex-1 flex items-center gap-3 px-3 py-2 bg-surface-light rounded-full">
      <span class="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
      <span class="text-sm text-gray-300">{formatTime(recordingTime)}</span>
      <div class="flex-1 h-1 bg-gray-600 rounded-full overflow-hidden">
        <div class="h-full bg-red-500 animate-pulse" style="width: 100%"></div>
      </div>
    </div>

    <button
      class="btn-primary w-11 h-11 p-0 flex items-center justify-center flex-shrink-0"
      onclick={stopAndSend}
      aria-label="Send voice message"
    >
      <span class="i-carbon-send text-xl"></span>
    </button>
  </div>
{:else}
  <!-- Loading state while requesting mic permission -->
  <div class="flex items-center gap-2 flex-1">
    <button
      class="w-11 h-11 p-0 flex items-center justify-center flex-shrink-0 text-red-400 hover:text-red-300 hover:bg-surface-light rounded-full transition-colors"
      onclick={cancel}
      aria-label="Cancel"
    >
      <span class="i-carbon-close text-xl"></span>
    </button>

    <div class="flex-1 flex items-center gap-3 px-3 py-2 bg-surface-light rounded-full">
      <span class="text-sm text-gray-400">Requesting microphone access...</span>
    </div>
  </div>
{/if}
