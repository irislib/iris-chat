<script lang="ts">
  import { onDestroy } from 'svelte'
  import { sendMessage, sendReaction, sendSeenReceipts, sendTypingEvent, deleteChat, deleteMessage, type ChatSession, type ChatMessage, currentChat } from '../lib/chat'
  import { isTyping } from '../lib/typingState'
  import { createTypingThrottle } from '../lib/typingState'
  import { uploadFile, formatFileLink, isImageFile, isVideoFile } from '../lib/hashtree'
  import { getDraft, setDraft, clearDraft } from '../lib/drafts'
  import { mediaModal, closeMediaModal } from '../lib/mediaModal'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  import MessageBubble from './MessageBubble.svelte'
  import MediaModal from './MediaModal.svelte'
  import VoiceRecorder from './VoiceRecorder.svelte'

  interface Props {
    chat: ChatSession
    onleave: () => void
    showBackButton?: boolean
    onViewProfile?: (pubkey: string) => void
  }

  let { chat, onleave, showBackButton = true, onViewProfile }: Props = $props()

  // Pending attachment for preview
  interface PendingAttachment {
    file: File
    previewUrl: string | null
    nhash: string | null
    uploading: boolean
    progress: number // 0-100
    error: string | null
  }

  let messageText = $state(getDraft(chat.id))
  let messagesContainer = $state<HTMLDivElement | null>(null)
  let inputRef = $state<HTMLTextAreaElement | null>(null)
  let fileInputRef = $state<HTMLInputElement | null>(null)
  let showMenu = $state(false)
  let pendingAttachment = $state<PendingAttachment | null>(null)
  let isRecordingVoice = $state(false)
  let activeChatId = $state(chat.id)
  let replyingTo = $state<ChatMessage | null>(null)

  // Throttled typing event sender - recreated per chat
  let sendThrottledTyping = $derived(createTypingThrottle(() => sendTypingEvent(chat), 3000))

  // Send typing event when user types
  $effect(() => {
    if (messageText.trim()) {
      sendThrottledTyping()
    }
  })

  // Save draft for old chat and restore draft for new chat when switching
  $effect(() => {
    const newChatId = chat.id
    if (newChatId !== activeChatId) {
      // Save current draft for the old chat
      setDraft(activeChatId, messageText)
      // Restore draft for the new chat
      messageText = getDraft(newChatId)
      activeChatId = newChatId
    }
  })

  // Continuously persist draft while typing
  $effect(() => {
    setDraft(activeChatId, messageText)
  })

  // Max file size for preview (10MB)
  const MAX_PREVIEW_SIZE = 10 * 1024 * 1024

  function handleDelete() {
    deleteChat(chat)
    onleave()
  }

  function handleSend() {
    // Build message with attachment link if present
    let text = messageText.trim()

    if (pendingAttachment?.nhash) {
      const link = formatFileLink(pendingAttachment.nhash, pendingAttachment.file.name)
      text = text ? `${text}\n${link}` : link
    }

    if (!text) return

    const replyToId = replyingTo?.id
    messageText = ''
    clearDraft(chat.id)
    clearAttachment()
    replyingTo = null

    sendMessage(chat, text, replyToId)

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

  function handleReply(message: ChatMessage) {
    replyingTo = message
    requestAnimationFrame(() => inputRef?.focus())
  }

  async function handleReact(messageId: string, emoji: string) {
    try {
      await sendReaction(chat, messageId, emoji)
    } catch (e) {
      console.error('Failed to send reaction:', e)
    }
  }

  async function handleDeleteMessage(messageId: string) {
    await deleteMessage(chat.id, messageId)
  }

  function clearAttachment() {
    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl)
    }
    pendingAttachment = null
  }

  async function handleVoiceRecorded(file: File) {
    isRecordingVoice = false

    // Clear any existing attachment
    clearAttachment()

    // Set pending attachment (no preview for audio)
    pendingAttachment = {
      file,
      previewUrl: null,
      nhash: null,
      uploading: true,
      progress: 0,
      error: null,
    }

    // Start upload
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

      // Auto-send voice message
      handleSend()
    } catch (e) {
      console.error('Failed to upload voice message:', e)
      if (pendingAttachment) {
        pendingAttachment = {
          ...pendingAttachment,
          uploading: false,
          error: e instanceof Error ? e.message : 'Upload failed',
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

    // Reset input so same file can be selected again
    input.value = ''

    // Clear any existing attachment
    clearAttachment()

    // Create preview URL for images/videos under size limit
    let previewUrl: string | null = null
    const canPreview = file.size < MAX_PREVIEW_SIZE &&
      (isImageFile(file.name) || isVideoFile(file.name))

    if (canPreview) {
      previewUrl = URL.createObjectURL(file)
    }

    // Set pending attachment
    pendingAttachment = {
      file,
      previewUrl,
      nhash: null,
      uploading: true,
      progress: 0,
      error: null,
    }

    // Start upload
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

      // Focus input after upload
      requestAnimationFrame(() => inputRef?.focus())
    } catch (e) {
      console.error('Failed to upload file:', e)
      if (pendingAttachment) {
        pendingAttachment = {
          ...pendingAttachment,
          uploading: false,
          error: e instanceof Error ? e.message : 'Upload failed',
        }
      }
    }
  }

  // Cleanup preview URLs on destroy
  onDestroy(() => {
    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl)
    }
  })

  // Track whether user is scrolled near the bottom
  let isAtBottom = true

  function handleMessagesScroll() {
    if (!messagesContainer) return
    const { scrollTop, scrollHeight, clientHeight } = messagesContainer
    isAtBottom = scrollHeight - scrollTop - clientHeight < 100
  }

  // Auto-scroll to bottom when new messages arrive or typing indicator appears
  $effect(() => {
    if (!messagesContainer) return
    $currentChat?.messages.length
    $isTyping.get(chat.id)
    if (isAtBottom) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight
    }
  })

  // Autofocus input when chat opens or changes
  $effect(() => {
    chat.id
    if (inputRef) {
      inputRef.focus()
    }
  })

  // Send seen receipts for incoming messages when chat is open
  $effect(() => {
    const msgs = $currentChat?.messages || chat.messages
    const unseenIncoming = msgs.filter(m => !m.isMine && m.status !== 'seen')
    if (unseenIncoming.length > 0) {
      sendSeenReceipts(chat, unseenIncoming.map(m => m.id))
    }
  })

  let messages = $derived($currentChat?.messages || chat.messages)
  // Build a map for quick reply lookups
  let messageMap = $derived(new Map(messages.map(m => [m.id, m])))
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
      onclick={() => onViewProfile?.(chat.recipientPubkey)}
      disabled={!onViewProfile}
    >
      <Avatar pubkey={chat.recipientPubkey} size={40} />
      <div class="flex-1 min-w-0 text-left">
        <p class="font-medium">
          <Name pubkey={chat.recipientPubkey} />
        </p>
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
          <button
            class="btn-ghost w-full text-left text-red-400 flex items-center gap-2"
            onclick={handleDelete}
          >
            <span class="i-carbon-trash-can"></span>
            Delete chat
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

  <!-- Messages - scrollable -->
  <div
    bind:this={messagesContainer}
    onscroll={handleMessagesScroll}
    class="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-4 min-h-0"
  >
    <!-- Invite started system message -->
    {#if chat.inviteId}
      <div class="text-center py-2 mb-2">
        <p class="text-sm text-gray-500">
          <span class="text-primary"><Name pubkey={chat.recipientPubkey} /></span>
          started the chat via invite link{#if chat.inviteLabel} <span class="text-gray-400">"{chat.inviteLabel}"</span>{/if}
        </p>
      </div>
    {/if}

    {#if messages.length === 0}
      <div class="text-center py-8">
        <div class="i-carbon-locked text-4xl text-primary mx-auto mb-2"></div>
        <p class="text-gray-400">End-to-end encrypted</p>
        <p class="text-sm text-gray-500">Messages are secured with double ratchet encryption</p>
      </div>
    {:else}
      {#each messages as message, i (message.id)}
        {@const prevMsg = messages[i - 1]}
        {@const nextMsg = messages[i + 1]}
        {@const isFirst = prevMsg?.isMine !== message.isMine}
        {@const isLast = nextMsg?.isMine !== message.isMine}
        {@const prevHasReactions = prevMsg?.reactions && Object.keys(prevMsg.reactions).length > 0}
        {@const hasReactions = message.reactions && Object.keys(message.reactions).length > 0}
        {@const replyToMessage = message.replyTo ? messageMap.get(message.replyTo) ?? null : null}
        <MessageBubble {message} {isFirst} {isLast} {prevHasReactions} {hasReactions} {replyToMessage} onreact={handleReact} ondelete={handleDeleteMessage} onreply={handleReply} />
      {/each}
    {/if}

    {#if $isTyping.get(chat.id)}
      <div class="flex items-end gap-2 mt-1">
        <div class="bg-surface-light rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
          <span class="typing-dot"></span>
          <span class="typing-dot" style="animation-delay: 0.15s"></span>
          <span class="typing-dot" style="animation-delay: 0.3s"></span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Input - flex-shrink-0 keeps it at bottom -->
  <div class="border-t border-surface-lighter flex-shrink-0 bg-[#0a0a0a]">
    <!-- Reply preview -->
    {#if replyingTo}
      <div class="px-4 pt-3 pb-1 flex items-center gap-2">
        <div class="flex-1 min-w-0 border-l-2 border-primary pl-3">
          <div class="text-xs text-primary font-semibold mb-0.5">
            {replyingTo.isMine ? 'You' : ''}
            {#if !replyingTo.isMine}
              <Name pubkey={chat.recipientPubkey} />
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
          <!-- Preview content -->
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
            <!-- File icon for non-previewable files -->
            <div class="flex items-center gap-2 px-3 py-2 bg-surface-light rounded-lg">
              <span class="i-carbon-document text-xl text-gray-400"></span>
              <span class="text-sm text-gray-300 max-w-32 truncate">{pendingAttachment.file.name}</span>
            </div>
          {/if}

          <!-- Progress overlay -->
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

          <!-- Error state -->
          {#if pendingAttachment.error}
            <div class="absolute inset-0 bg-red-900/60 rounded-lg flex items-center justify-center">
              <span class="i-carbon-warning-alt text-red-400 text-xl"></span>
            </div>
          {/if}

          <!-- Remove button -->
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
      <!-- Hidden file input -->
      <input
        bind:this={fileInputRef}
        type="file"
        class="hidden"
        onchange={handleFileSelect}
        accept="image/*,video/*,audio/*,.pdf,.txt,.json,.md"
      />

      {#if isRecordingVoice}
        <!-- Voice recording UI -->
        <VoiceRecorder
          onrecorded={handleVoiceRecorded}
          oncancel={handleVoiceCancel}
        />
      {:else}
        <!-- Attachment button -->
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
          placeholder="Type a message..."
          class="input-field flex-1 resize-none min-h-[44px] max-h-32 py-3"
          rows="1"
          autofocus
        ></textarea>

        <!-- Voice/Send button -->
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
