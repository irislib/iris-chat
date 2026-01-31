<script lang="ts">
  import { onDestroy } from 'svelte'
  import { sendGroupMessage, sendGroupReaction, sendGroupTypingEvent, deleteGroup, acceptGroupInvitation, groupMessages, currentGroupId, type Group, type GroupMessage } from '../lib/groups'
  import { isTyping } from '../lib/typingState'
  import { createTypingThrottle } from '../lib/typingState'
  import { uploadFile, formatFileLink, isImageFile, isVideoFile } from '../lib/hashtree'
  import { getDraft, setDraft, clearDraft } from '../lib/drafts'
  import { getErrorMessage, formatDayLabel, isDifferentDay } from '../lib/utils'
  import { mediaModal, closeMediaModal } from '../lib/mediaModal'
  import { getPubkey } from '../lib/identity'
  import { deleteMessage as deleteMessageFromDb } from '../lib/storage'
  import MessageBubble from './MessageBubble.svelte'
  import MediaModal from './MediaModal.svelte'
  import VoiceRecorder from './VoiceRecorder.svelte'
  import Name from './Name.svelte'
  import GroupAvatar from './GroupAvatar.svelte'

  interface Props {
    group: Group
    onleave: () => void
    showBackButton?: boolean
    onViewDetails?: () => void
  }

  let { group, onleave, showBackButton = true, onViewDetails }: Props = $props()

  interface PendingAttachment {
    file: File
    previewUrl: string | null
    nhash: string | null
    uploading: boolean
    progress: number
    error: string | null
  }

  // svelte-ignore state_referenced_locally
  let messageText = $state(getDraft(`group:${group.id}`))
  let messagesContainer = $state<HTMLDivElement | null>(null)
  let inputRef = $state<HTMLTextAreaElement | null>(null)
  let fileInputRef = $state<HTMLInputElement | null>(null)
  let showMenu = $state(false)
  let pendingAttachment = $state<PendingAttachment | null>(null)
  let isRecordingVoice = $state(false)
  // svelte-ignore state_referenced_locally
  let activeGroupId = $state(group.id)
  let replyingTo = $state<GroupMessage | null>(null)

  // Set current group id
  $effect(() => {
    currentGroupId.set(group.id)
    return () => {
      currentGroupId.set(null)
    }
  })

  let sendThrottledTyping = $derived(createTypingThrottle(() => sendGroupTypingEvent(group.id), 3000))

  function handleTypingInput() {
    if (messageText.trim()) {
      sendThrottledTyping.fire()
    }
  }

  $effect(() => {
    const newId = group.id
    if (newId !== activeGroupId) {
      setDraft(`group:${activeGroupId}`, messageText)
      messageText = getDraft(`group:${newId}`)
      activeGroupId = newId
    }
  })

  $effect(() => {
    setDraft(`group:${activeGroupId}`, messageText)
  })

  const MAX_PREVIEW_SIZE = 10 * 1024 * 1024

  function handleDelete() {
    deleteGroup(group.id)
    onleave()
  }

  function handleSend() {
    let text = messageText.trim()

    if (pendingAttachment?.nhash) {
      const link = formatFileLink(pendingAttachment.nhash, pendingAttachment.file.name)
      text = text ? `${text}\n${link}` : link
    }

    if (!text) return

    const replyToId = replyingTo?.id
    messageText = ''
    clearDraft(`group:${group.id}`)
    clearAttachment()
    replyingTo = null
    sendThrottledTyping.reset()

    sendGroupMessage(group.id, text, replyToId)

    requestAnimationFrame(() => inputRef?.focus())
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    } else if (e.key === 'Escape') {
      if (replyingTo) {
        replyingTo = null
      } else {
        inputRef?.blur()
      }
    }
  }

  function handleReply(message: GroupMessage) {
    replyingTo = message
    requestAnimationFrame(() => inputRef?.focus())
  }

  async function handleReact(messageId: string, emoji: string) {
    try {
      sendGroupReaction(group.id, messageId, emoji)
    } catch (e) {
      console.error('Failed to send reaction:', e)
    }
  }

  async function handleDeleteMessage(messageId: string) {
    groupMessages.update(gm => {
      const msgs = gm.get(group.id) || []
      gm.set(group.id, msgs.filter(m => m.id !== messageId))
      return gm
    })
    await deleteMessageFromDb(messageId)
  }

  function clearAttachment() {
    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl)
    }
    pendingAttachment = null
  }

  async function handleVoiceRecorded(file: File) {
    isRecordingVoice = false
    clearAttachment()

    pendingAttachment = {
      file,
      previewUrl: null,
      nhash: null,
      uploading: true,
      progress: 0,
      error: null,
    }

    try {
      const { nhash } = await uploadFile(file, (bytesUploaded, totalBytes) => {
        if (pendingAttachment) {
          pendingAttachment = {
            ...pendingAttachment,
            progress: Math.round((bytesUploaded / totalBytes) * 100),
          }
        }
      })

      if (pendingAttachment) {
        pendingAttachment = {
          ...pendingAttachment,
          nhash,
          uploading: false,
          progress: 100,
        }
      }

      handleSend()
    } catch (e) {
      console.error('Failed to upload voice message:', e)
      if (pendingAttachment) {
        pendingAttachment = {
          ...pendingAttachment,
          uploading: false,
          error: getErrorMessage(e, 'Upload failed'),
        }
      }
    }
  }

  function handleVoiceCancel() {
    isRecordingVoice = false
  }

  async function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    input.value = ''
    clearAttachment()

    let previewUrl: string | null = null
    const canPreview = file.size < MAX_PREVIEW_SIZE &&
      (isImageFile(file.name) || isVideoFile(file.name))

    if (canPreview) {
      previewUrl = URL.createObjectURL(file)
    }

    pendingAttachment = {
      file,
      previewUrl,
      nhash: null,
      uploading: true,
      progress: 0,
      error: null,
    }

    try {
      const { nhash } = await uploadFile(file, (bytesUploaded, totalBytes) => {
        if (pendingAttachment) {
          pendingAttachment = {
            ...pendingAttachment,
            progress: Math.round((bytesUploaded / totalBytes) * 100),
          }
        }
      })

      if (pendingAttachment) {
        pendingAttachment = {
          ...pendingAttachment,
          nhash,
          uploading: false,
          progress: 100,
        }
      }

      requestAnimationFrame(() => inputRef?.focus())
    } catch (e) {
      console.error('Failed to upload file:', e)
      if (pendingAttachment) {
        pendingAttachment = {
          ...pendingAttachment,
          uploading: false,
          error: getErrorMessage(e, 'Upload failed'),
        }
      }
    }
  }

  onDestroy(() => {
    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl)
    }
  })

  let isAtBottom = true

  function handleMessagesScroll() {
    if (!messagesContainer) return
    const { scrollTop, scrollHeight, clientHeight } = messagesContainer
    isAtBottom = scrollHeight - scrollTop - clientHeight < 100
  }

  $effect(() => {
    if (!messagesContainer) return
    const msgs = $groupMessages.get(group.id)
    msgs?.length
    $isTyping.get(`group:${group.id}`)
    if (isAtBottom) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight
    }
  })

  $effect(() => {
    group.id
    if (inputRef) {
      inputRef.focus()
    }
  })

  let messages = $derived(($groupMessages.get(group.id) || []) as GroupMessage[])
  let messageMap = $derived(new Map(messages.map(m => [m.id, m])))
  let myPubkey = $derived(getPubkey())

  let canSend = $derived(
    (messageText.trim() || pendingAttachment?.nhash) &&
    !pendingAttachment?.uploading
  )
</script>

<div class="flex-1 flex flex-col min-h-0">
  <!-- Header -->
  <header class="h-16 px-4 flex items-center gap-3 border-b border-surface-lighter flex-shrink-0 bg-[#0a0a0a]">
    {#if showBackButton}
      <button
        class="btn-ghost p-2 rounded-full"
        onclick={onleave}
        aria-label="Back"
      >
        <span class="i-carbon-arrow-left text-xl"></span>
      </button>
    {/if}

    <button
      class="flex items-center gap-3 flex-1 min-w-0 hover:opacity-80 transition-opacity"
      onclick={() => onViewDetails?.()}
      disabled={!onViewDetails}
    >
      <GroupAvatar picture={group.picture} size={40} />
      <div class="flex-1 min-w-0 text-left">
        <p class="font-medium truncate">{group.name}</p>
        <p class="text-xs text-gray-500">{group.members.length} members</p>
      </div>
    </button>

    <!-- Menu -->
    <div class="relative">
      <button
        class="p-2 rounded-full text-gray-400 hover:bg-surface-light hover:text-white transition-colors"
        onclick={() => showMenu = !showMenu}
        aria-label="Chat menu"
      >
        <span class="i-carbon-overflow-menu-horizontal text-xl"></span>
      </button>

      {#if showMenu}
        <div class="absolute right-0 top-full mt-1 w-40 bg-surface border border-surface-lighter rounded-lg shadow-xl z-50">
          {#if onViewDetails}
            <button
              class="btn-ghost w-full text-left flex items-center gap-2"
              onclick={() => { showMenu = false; onViewDetails?.() }}
            >
              <span class="i-carbon-information"></span>
              Group info
            </button>
          {/if}
          <button
            class="btn-ghost w-full text-left text-red-400 flex items-center gap-2"
            onclick={handleDelete}
          >
            <span class="i-carbon-trash-can"></span>
            Delete group
          </button>
        </div>
      {/if}
    </div>
  </header>

  {#if showMenu}
    <button
      class="fixed inset-0 z-10 bg-transparent border-none cursor-default"
      onclick={() => showMenu = false}
      aria-label="Close menu"
    ></button>
  {/if}

  <!-- Invite banner for unaccepted groups -->
  {#if group.accepted !== true}
    <div class="px-4 py-3 bg-primary/10 border-b border-primary/20 flex items-center gap-3 flex-shrink-0">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium">You've been invited to <strong>{group.name}</strong></p>
        <p class="text-xs text-gray-400 mt-0.5">Accept to join and exchange messages</p>
      </div>
      <button
        class="btn-primary px-4 py-2 text-sm flex-shrink-0"
        onclick={() => acceptGroupInvitation(group.id)}
      >
        Accept
      </button>
      <button
        class="px-4 py-2 text-sm text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors flex-shrink-0"
        onclick={handleDelete}
      >
        Decline
      </button>
    </div>
  {/if}

  <!-- Messages - scrollable -->
  <div
    bind:this={messagesContainer}
    onscroll={handleMessagesScroll}
    class="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-4 min-h-0"
  >
    {#if messages.length === 0}
      <div class="text-center py-8">
        <div class="i-carbon-group text-4xl text-primary mx-auto mb-2"></div>
        <p class="text-gray-400">Group created</p>
        <p class="text-sm text-gray-500">Messages are end-to-end encrypted</p>
      </div>
    {:else}
      {#each messages as message, i (message.id)}
        {@const prevMsg = messages[i - 1]}
        {@const nextMsg = messages[i + 1]}
        {@const newDay = !prevMsg || isDifferentDay(prevMsg.timestamp, message.timestamp)}
        {@const timeGapPrev = prevMsg ? (message.timestamp - prevMsg.timestamp) > 3 * 60 * 1000 : false}
        {@const timeGapNext = nextMsg ? (nextMsg.timestamp - message.timestamp) > 3 * 60 * 1000 : false}
        {@const sameSenderAsPrev = prevMsg && !prevMsg.isMine && !message.isMine && prevMsg.senderPubkey === message.senderPubkey}
        {@const sameSenderAsNext = nextMsg && !nextMsg.isMine && !message.isMine && nextMsg.senderPubkey === message.senderPubkey}
        {@const isFirst = !sameSenderAsPrev || prevMsg?.isMine !== message.isMine || timeGapPrev || newDay}
        {@const isLast = !sameSenderAsNext || nextMsg?.isMine !== message.isMine || timeGapNext || (nextMsg && isDifferentDay(message.timestamp, nextMsg.timestamp))}
        {@const prevHasReactions = prevMsg?.reactions && Object.keys(prevMsg.reactions).length > 0}
        {@const hasReactions = message.reactions && Object.keys(message.reactions).length > 0}
        {@const replyToMessage = message.replyTo ? messageMap.get(message.replyTo) ?? null : null}
        {@const showSenderName = !message.isMine && isFirst && !!message.senderPubkey}
        {#if newDay}
          <div class="day-separator sticky top-0 z-10 flex justify-center py-2 pointer-events-none">
            <span class="px-3 py-1 rounded-full text-xs text-gray-400 bg-[#0a0a0a]/60 backdrop-blur-md shadow-sm pointer-events-auto">
              {formatDayLabel(message.timestamp)}
            </span>
          </div>
        {/if}
        <MessageBubble
          {message}
          {isFirst}
          {isLast}
          {prevHasReactions}
          {hasReactions}
          {showSenderName}
          senderPubkey={message.senderPubkey}
          {replyToMessage}
          onreact={handleReact}
          ondelete={handleDeleteMessage}
          onreply={handleReply}
        />
      {/each}
    {/if}

    {#if $isTyping.get(`group:${group.id}`)}
      <div class="flex items-end gap-2 mt-1">
        <div class="bg-surface-light rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
          <span class="typing-dot"></span>
          <span class="typing-dot" style="animation-delay: 0.15s"></span>
          <span class="typing-dot" style="animation-delay: 0.3s"></span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Input -->
  <div class="border-t border-surface-lighter flex-shrink-0 bg-[#0a0a0a]">
    <!-- Reply preview -->
    {#if replyingTo}
      <div class="px-4 pt-3 pb-1 flex items-center gap-2">
        <div class="flex-1 min-w-0 border-l-2 border-primary pl-3">
          <div class="text-xs text-primary font-semibold mb-0.5">
            {#if replyingTo.isMine}
              You
            {:else if replyingTo.senderPubkey}
              <Name pubkey={replyingTo.senderPubkey} />
            {/if}
          </div>
          <div class="text-sm text-gray-400 truncate">{replyingTo.content}</div>
        </div>
        <button
          class="w-7 h-7 flex-shrink-0 rounded-full hover:bg-surface-light flex items-center justify-center text-gray-400 hover:text-white transition-colors"
          onclick={() => replyingTo = null}
          aria-label="Cancel reply"
        >
          <span class="i-carbon-close text-sm"></span>
        </button>
      </div>
    {/if}

    <!-- Attachment preview -->
    {#if pendingAttachment}
      <div class="px-4 pt-3 pb-2">
        <div class="relative inline-block">
          {#if pendingAttachment.previewUrl && isImageFile(pendingAttachment.file.name)}
            <img
              src={pendingAttachment.previewUrl}
              alt={pendingAttachment.file.name}
              class="max-h-32 max-w-48 rounded-lg object-cover"
            />
          {:else if pendingAttachment.previewUrl && isVideoFile(pendingAttachment.file.name)}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              src={pendingAttachment.previewUrl}
              class="max-h-32 max-w-48 rounded-lg object-cover"
            ></video>
          {:else}
            <div class="flex items-center gap-2 px-3 py-2 bg-surface-light rounded-lg">
              <span class="i-carbon-document text-xl text-gray-400"></span>
              <span class="text-sm text-gray-300 max-w-32 truncate">{pendingAttachment.file.name}</span>
            </div>
          {/if}

          {#if pendingAttachment.uploading}
            <div class="absolute inset-0 bg-black/60 rounded-lg flex items-center justify-center">
              <div class="text-center">
                <div class="text-white text-sm font-medium">{pendingAttachment.progress}%</div>
                <div class="w-16 h-1 bg-gray-600 rounded-full mt-1 overflow-hidden">
                  <div
                    class="h-full bg-primary transition-all duration-150"
                    style="width: {pendingAttachment.progress}%"
                  ></div>
                </div>
              </div>
            </div>
          {/if}

          {#if pendingAttachment.error}
            <div class="absolute inset-0 bg-red-900/60 rounded-lg flex items-center justify-center">
              <span class="i-carbon-warning-alt text-red-400 text-xl"></span>
            </div>
          {/if}

          <button
            class="absolute -top-2 -right-2 w-6 h-6 bg-surface border border-surface-lighter rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-red-600 hover:border-red-600 transition-colors"
            onclick={clearAttachment}
            aria-label="Remove attachment"
          >
            <span class="i-carbon-close text-sm"></span>
          </button>
        </div>
      </div>
    {/if}

    <!-- Input row -->
    <div class="p-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] flex gap-2 items-end">
      <input
        bind:this={fileInputRef}
        type="file"
        class="hidden"
        onchange={handleFileSelect}
        accept="image/*,video/*,audio/*,.pdf,.txt,.json,.md"
      />

      {#if isRecordingVoice}
        <VoiceRecorder
          onrecorded={handleVoiceRecorded}
          oncancel={handleVoiceCancel}
        />
      {:else}
        <button
          class="w-11 h-11 p-0 flex items-center justify-center flex-shrink-0 text-gray-400 hover:text-white hover:bg-surface-light rounded-full transition-colors"
          onclick={() => fileInputRef?.click()}
          disabled={pendingAttachment?.uploading}
          aria-label="Attach file"
        >
          <span class="i-carbon-attachment text-xl"></span>
        </button>

        <!-- svelte-ignore a11y_autofocus -->
        <textarea
          bind:this={inputRef}
          bind:value={messageText}
          onkeydown={handleKeydown}
          oninput={handleTypingInput}
          placeholder="Type a message..."
          class="input-field flex-1 resize-none min-h-[44px] max-h-32 py-3"
          rows="1"
          autofocus
        ></textarea>

        {#if messageText.trim() || pendingAttachment?.nhash}
          <button
            class="btn-primary w-11 h-11 p-0 flex items-center justify-center flex-shrink-0"
            onclick={handleSend}
            disabled={!canSend}
            aria-label="Send"
          >
            <span class="i-carbon-send text-xl"></span>
          </button>
        {:else}
          <button
            class="w-11 h-11 p-0 flex items-center justify-center flex-shrink-0 text-gray-400 hover:text-white hover:bg-surface-light rounded-full transition-colors"
            onclick={() => isRecordingVoice = true}
            disabled={pendingAttachment?.uploading}
            aria-label="Record voice message"
          >
            <span class="i-carbon-microphone text-xl"></span>
          </button>
        {/if}
      {/if}
    </div>
  </div>
</div>

<!-- Media Modal -->
{#if $mediaModal.open}
  <MediaModal
    src={$mediaModal.src}
    nhash={$mediaModal.nhash}
    filename={$mediaModal.filename}
    type={$mediaModal.type}
    onclose={closeMediaModal}
  />
{/if}

<style>
  .typing-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: #9ca3af;
    animation: typing-bounce 1.2s ease-in-out infinite;
  }

  @keyframes typing-bounce {
    0%, 60%, 100% {
      transform: translateY(0);
      opacity: 0.4;
    }
    30% {
      transform: translateY(-6px);
      opacity: 1;
    }
  }
</style>
