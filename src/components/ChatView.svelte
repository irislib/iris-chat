<script lang="ts">
  import ChatPinButton from './ChatPinButton.svelte'
  import { onDestroy } from 'svelte'
  import { createAttachmentDraft, filesFromTransfer, hasFileData } from '../lib/attachmentDraft'
  import { sendMessage, sendReaction, sendSeenReceipts, sendTypingEvent, deleteChat, deleteMessage, type ChatSession, type ChatMessage, currentChat } from '../lib/chat'
  import { identity } from '../lib/identity'
  import { following } from '../lib/following'
  import { messageRequests, acceptChat, rejectChat } from '../lib/messageRequests'
  import { messageRequestSettings } from '../lib/messageRequestSettings'
  import { isMessageRequestChat, type MessageRequestPolicyContext } from '../lib/messageRequestPolicy'
  import { isTyping } from '../lib/typingState'
  import { createTypingThrottle } from '../lib/typingState'
  import { uploadFile, formatFileLink, isImageFile, isVideoFile } from '../lib/hashtree'
  import { getDraft, setDraft, clearDraft } from '../lib/drafts'
  import { formatDayLabel, isDifferentDay } from '../lib/utils'
  import { mediaModal, closeMediaModal } from '../lib/mediaModal'
  import { expirationStore } from '../lib/expirationStore'
  import { setDmDisappearingMessages } from '../lib/disappearingMessages'
  import { getExpirationLabel } from '../lib/expiration'
  import { buildDisappearingNotice, normalizeDisappearingTtl } from '../lib/disappearingNotice'
  import Avatar from './Avatar.svelte'
  import { startCall, callState } from '../lib/calls'
  import { callSettings } from '../lib/callSettings'
  import Name from './Name.svelte'
  import MessageBubble from './MessageBubble.svelte'
  import CallHistoryRow from './CallHistoryRow.svelte'
  import MediaModal from './MediaModal.svelte'
  import VoiceRecorder from './VoiceRecorder.svelte'
  import ChatMuteModal from './ChatMuteModal.svelte'
  import { chatMutes } from '../lib/chatMuteStore'
  import { isChatMuted } from '../lib/chatMutePolicy'
  import DisappearingMessagesModal from './DisappearingMessagesModal.svelte'
  import EmojiPicker from './EmojiPicker.svelte'

  interface Props {
    chat: ChatSession
    onleave: () => void
    showBackButton?: boolean
    onViewProfile?: (pubkey: string) => void
  }

  let { chat, onleave, showBackButton = true, onViewProfile }: Props = $props()
  let showEmojiPicker = $state(false)
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

  // svelte-ignore state_referenced_locally — initial values; the $effect below handles chat switching
  let messageText = $state(getDraft(chat.id))
  let messagesContainer = $state<HTMLDivElement | null>(null)
  let inputRef = $state<HTMLTextAreaElement | null>(null)
  let fileInputRef = $state<HTMLInputElement | null>(null)
  let showMenu = $state(false)
  let showMuteModal = $state(false)
  const attachmentContext = () => `${$identity?.pubkey || ''}:chat:${chat.id}`
  const attachmentDraft = createAttachmentDraft({
    context: attachmentContext,
    upload: uploadFile,
    canPreview: file => file.size < 10 * 1024 * 1024 && (isImageFile(file.name) || isVideoFile(file.name)),
  })
  let isFileDrag = $state(false)
  let attachmentError = $state<string | null>(null)
  let uploadingAttachments = $derived($attachmentDraft.some(item => item.uploading))
  $effect(() => { attachmentDraft.setContext(attachmentContext()) })
  let isRecordingVoice = $state(false)
  let recordingContext: string | null = null
  // svelte-ignore state_referenced_locally
  let activeChatId = $state(chat.id)
  let replyingTo = $state<ChatMessage | null>(null)
  let showDisappearingModal = $state(false)

  let currentTtl = $derived($expirationStore.expirations[chat.id])
  let disappearingNotice = $state<string | null>(null)
  let lastSeenDisappearingTtl = $state<number | null | undefined>(undefined)
  let disappearingNoticeTimer = $state<ReturnType<typeof setTimeout> | null>(null)
  let myPubkey = $derived($identity?.pubkey || null)

  async function handleSetDisappearing(ttlSeconds: number | null) {
    await setDmDisappearingMessages(chat.id, ttlSeconds)
  }

  let policyCtx = $derived.by((): MessageRequestPolicyContext => ({
    myPubkey: $identity?.pubkey || null,
    following: $following,
    acceptedChats: $messageRequests.acceptedChats,
    rejectedChats: $messageRequests.rejectedChats,
    receiveMessageRequests: $messageRequestSettings.receiveMessageRequests,
  }))

  let effectiveChat = $derived($currentChat || chat)
  let isRequest = $derived(isMessageRequestChat(effectiveChat, policyCtx))
  let attachmentAllowed = $derived(!!$identity && !isRequest && !$messageRequests.rejectedChats[chat.recipientPubkey])
  let canAttach = $derived(attachmentAllowed && !isRecordingVoice)
  $effect(() => {
    if (!attachmentAllowed) {
      attachmentDraft.clear()
      isRecordingVoice = false
      recordingContext = null
      isFileDrag = false
    }
  })

  // Throttled typing event sender - recreated per chat
  let sendThrottledTyping = $derived(createTypingThrottle(() => sendTypingEvent(chat), 3000))

  // Send typing event when user types (imperative, not reactive)
  function handleTypingInput() {
    if (messageText.trim()) {
      sendThrottledTyping.fire()
    }
  }

  // Save draft for old chat and restore draft for new chat when switching
  $effect(() => {
    const newChatId = chat.id
    if (newChatId !== activeChatId) {
      // Save current draft for the old chat
      setDraft(activeChatId, messageText)
      // Restore draft for the new chat
      messageText = getDraft(newChatId)
      isRecordingVoice = false
      recordingContext = null
      replyingTo = null
      isFileDrag = false
      attachmentError = null
      activeChatId = newChatId
    }
  })

  // Continuously persist draft while typing
  $effect(() => {
    setDraft(activeChatId, messageText)
  })


  function handleDelete() {
    deleteChat(chat)
    onleave()
  }

  function handleAcceptRequest() {
    acceptChat(chat.recipientPubkey)
    requestAnimationFrame(() => inputRef?.focus())
  }

  function handleRejectRequest() {
    rejectChat(chat.recipientPubkey)
    deleteChat(chat)
    onleave()
  }

  function handleSend() {
    if (!canSend) return
    // Build message with attachment link if present
    let text = messageText.trim()

    for (const attachment of $attachmentDraft) {
      if (!attachment.nhash) continue
      const link = formatFileLink(attachment.nhash, attachment.file.name)
      text = text ? `${text}\n${link}` : link
    }

    if (!text) return

    const replyToId = replyingTo?.id
    messageText = ''
    clearDraft(chat.id)
    clearAttachment()
    replyingTo = null
    sendThrottledTyping.reset()

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
    attachmentDraft.clear()
    attachmentError = null
  }

  function startVoiceRecording() {
    if (!canAttach) return
    recordingContext = attachmentContext()
    isRecordingVoice = true
  }

  async function handleVoiceRecorded(file: File) {
    if (recordingContext !== attachmentContext() || !attachmentAllowed) return
    recordingContext = null
    isRecordingVoice = false
    clearAttachment()
    const context = attachmentContext()
    const completed = await attachmentDraft.add([file])
    // Keep the existing voice-send flow, but never send a removed recording,
    // another selection, or a draft opened while this recording was uploading.
    if (context === attachmentContext() && completed.length === 1 &&
        $attachmentDraft.length === 1 && $attachmentDraft[0].id === completed[0]) handleSend()
  }

  function handleVoiceCancel() { isRecordingVoice = false; recordingContext = null }

  function attachFiles(files: File[]) {
    if (!canAttach || files.length === 0) return
    attachmentError = null
    void attachmentDraft.add(files)
    inputRef?.focus()
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement
    const files = Array.from(input.files || [])
    input.value = ''
    attachFiles(files)
  }

  function handleDrop(e: DragEvent) {
    isFileDrag = false
    if (!hasFileData(e.dataTransfer)) {
      // Do not let a dragged web link navigate away from the unsent draft.
      if (Array.from(e.dataTransfer?.types || []).includes('text/uri-list')) e.preventDefault()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    if (!canAttach) return
    const files = filesFromTransfer(e.dataTransfer)
    if (!files) { attachmentError = 'Choose files, not folders'; return }
    attachFiles(files)
  }

  function handleDragOver(e: DragEvent) {
    if (!hasFileData(e.dataTransfer)) {
      // Do not let a dragged web link navigate away from the unsent draft.
      if (Array.from(e.dataTransfer?.types || []).includes('text/uri-list')) e.preventDefault()
      return
    }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = canAttach ? 'copy' : 'none'
    isFileDrag = canAttach
  }

  function handleDragLeave(e: DragEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) isFileDrag = false
  }

  function handlePaste(e: ClipboardEvent) {
    const files = filesFromTransfer(e.clipboardData)
    if (!files || !canAttach) return
    e.preventDefault()
    attachFiles(files)
  }

  // Cleanup preview URLs on destroy
  onDestroy(() => {
    recordingContext = null
    attachmentDraft.clear()
    if (disappearingNoticeTimer) {
      clearTimeout(disappearingNoticeTimer)
      disappearingNoticeTimer = null
    }
  })

  $effect(() => {
    const normalizedTtl = normalizeDisappearingTtl(currentTtl)
    if (lastSeenDisappearingTtl === undefined) {
      lastSeenDisappearingTtl = normalizedTtl
      return
    }
    if (lastSeenDisappearingTtl === normalizedTtl) return
    lastSeenDisappearingTtl = normalizedTtl

    disappearingNotice = buildDisappearingNotice(normalizedTtl)
    if (disappearingNoticeTimer) clearTimeout(disappearingNoticeTimer)
    disappearingNoticeTimer = setTimeout(() => {
      disappearingNotice = null
      disappearingNoticeTimer = null
    }, 3000)
  })

  // Track whether user is scrolled near the bottom
  let isAtBottom = $state(true)

  function handleMessagesScroll() {
    if (!messagesContainer) return
    const { scrollTop, scrollHeight, clientHeight } = messagesContainer
    isAtBottom = scrollHeight - scrollTop - clientHeight < 100
  }

  function scrollToBottom() {
    if (!messagesContainer) return
    messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' })
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
    !!$identity && !$messageRequests.rejectedChats[chat.recipientPubkey] &&
    ($attachmentDraft.length === 0 || attachmentAllowed) &&
    !!(messageText.trim() || $attachmentDraft.length) &&
    $attachmentDraft.every(item => !!item.nhash && !item.uploading && !item.error)
  )
</script>

<div class="flex-1 flex flex-col min-h-0 relative" role="presentation"
  data-testid="chat-file-drop-area"
  ondragover={handleDragOver} ondragleave={handleDragLeave} ondrop={handleDrop}>
  {#if isFileDrag}
    <div data-testid="file-drop-highlight" class="absolute inset-1 z-40 rounded-xl border-2 border-solid border-primary pointer-events-none"></div>
  {/if}
  <!-- Header -->
  <header class="h-16 px-4 flex items-center gap-3 border-b border-surface-lighter flex-shrink-0 bg-panel">
    {#if showBackButton}
      <button
        class="chat-header-button"
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
        <p class="font-medium truncate">
          <Name pubkey={chat.recipientPubkey} />
        </p>
      </div>
    </button>

    {#if !isRequest}
      {#if $callSettings.video}
        <button class="chat-header-button" aria-label="Video call" title="Video call" disabled={!!$callState && $callState.status !== 'ended'} onclick={() => startCall(chat.recipientPubkey, true)}><span class="i-carbon-video-filled text-xl"></span></button>
      {/if}
      {#if $callSettings.voice}
        <button class="chat-header-button" aria-label="Voice call" title="Voice call" disabled={!!$callState && $callState.status !== 'ended'} onclick={() => startCall(chat.recipientPubkey, false)}><span class="i-carbon-phone-filled text-xl"></span></button>
      {/if}
    {/if}

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
        <div class="absolute right-0 top-full mt-1 w-56 bg-surface border border-surface-lighter rounded-lg shadow-xl z-50">
          <ChatPinButton chatId={chat.id} />
          <button class="btn-ghost w-full text-left flex items-center gap-2" onclick={() => { showMenu = false; showMuteModal = true }}>
            <span class="i-carbon-notification-off"></span>
            {isChatMuted($chatMutes, chat.id) ? 'Muted notifications' : 'Mute notifications'}
          </button>
          <button
            class="btn-ghost w-full text-left flex items-center gap-2"
            onclick={() => { showMenu = false; showDisappearingModal = true }}
          >
            <span class="i-carbon-time"></span>
            Disappearing messages
            {#if currentTtl}
              <span class="ml-auto text-xs text-primary">{getExpirationLabel(currentTtl)}</span>
            {/if}
          </button>
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

  {#if disappearingNotice}
    <div class="px-4 py-2 border-b border-surface-lighter bg-surface text-sm text-primary">
      {disappearingNotice}
    </div>
  {/if}

  {#if isRequest}
    <div class="px-4 py-3 border-b border-surface-lighter bg-surface flex items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm font-medium">Message request</p>
        <p class="text-xs text-gray-400 truncate">Accept to start chatting (no receipts or typing until then)</p>
      </div>
      <div class="flex gap-2 flex-shrink-0">
        <button class="btn-primary text-sm px-3" onclick={handleAcceptRequest} data-testid="request-accept-chat">
          Accept
        </button>
        <button class="btn-ghost text-sm px-3 text-red-400" onclick={handleRejectRequest} data-testid="request-reject-chat">
          Reject
        </button>
      </div>
    </div>
  {/if}

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
        {@const newDay = !prevMsg || isDifferentDay(prevMsg.timestamp, message.timestamp)}
        {@const timeGapPrev = prevMsg ? (message.timestamp - prevMsg.timestamp) > 3 * 60 * 1000 : false}
        {@const timeGapNext = nextMsg ? (nextMsg.timestamp - message.timestamp) > 3 * 60 * 1000 : false}
        {@const isFirst = !!prevMsg?.call || prevMsg?.isMine !== message.isMine || timeGapPrev || newDay}
        {@const isLast = !!nextMsg?.call || nextMsg?.isMine !== message.isMine || timeGapNext || (nextMsg && isDifferentDay(message.timestamp, nextMsg.timestamp))}
        {@const prevHasReactions = prevMsg?.reactions && Object.keys(prevMsg.reactions).length > 0}
        {@const hasReactions = message.reactions && Object.keys(message.reactions).length > 0}
        {@const replyToMessage = message.replyTo ? messageMap.get(message.replyTo) ?? null : null}
        {#if newDay}
          <div class="day-separator sticky top-0 z-10 flex justify-center py-2 pointer-events-none">
            <span class="px-3 py-1 rounded-full text-xs text-gray-400 bg-panel/60 backdrop-blur-md shadow-sm pointer-events-auto">
              {formatDayLabel(message.timestamp)}
            </span>
          </div>
        {/if}
        {#if message.call}
          <CallHistoryRow call={message.call} />
        {:else}
        <MessageBubble
          {message}
          {isFirst}
          {isLast}
          {prevHasReactions}
          {hasReactions}
          {replyToMessage}
          {myPubkey}
          recipientPubkey={chat.recipientPubkey}
          onreact={handleReact}
          ondelete={handleDeleteMessage}
          onreply={handleReply}
        />
        {/if}
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

  <!-- Scroll to bottom button -->
  {#if !isAtBottom}
    <div class="relative flex-shrink-0">
      <button
        class="absolute -top-12 right-4 w-10 h-10 rounded-full bg-surface-light border border-surface-lighter shadow-lg flex items-center justify-center text-gray-300 hover:text-white hover:bg-surface transition-all z-20"
        onclick={scrollToBottom}
        aria-label="Scroll to bottom"
      >
        <span class="i-carbon-chevron-down text-xl"></span>
      </button>
    </div>
  {/if}

  <!-- Input - flex-shrink-0 keeps it at bottom -->
  <div class="border-t border-surface-lighter flex-shrink-0 bg-panel">
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
    {#if $attachmentDraft.length}
      <div class="px-4 pt-3 pb-2 flex gap-4 overflow-x-auto">
        {#each $attachmentDraft as pendingAttachment (pendingAttachment.id)}
        <div class="relative inline-block flex-shrink-0" data-testid="attachment-preview">
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
            onclick={() => attachmentDraft.remove(pendingAttachment.id)}
            aria-label="Remove attachment"
          >
            <span class="i-carbon-close text-sm"></span>
          </button>
        </div>
        {/each}
      </div>
    {/if}

    {#if attachmentError}
      <p role="status" class="px-4 pt-2 text-sm text-red-400">{attachmentError}</p>
    {/if}

    <!-- Input row -->
    <div
      class="p-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] flex gap-2 items-end"
      role="presentation"
    >
      <!-- Hidden file input -->
      <input
        bind:this={fileInputRef}
        type="file"
        multiple
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
        <!-- Emoji picker button (desktop only) -->
        {#if !isMobile}
          <div class="relative flex-shrink-0">
            <button
              class="w-11 h-11 p-0 flex items-center justify-center flex-shrink-0 text-gray-400 hover:text-white hover:bg-surface-light rounded-full transition-colors"
              onclick={() => showEmojiPicker = !showEmojiPicker}
              aria-label="Emoji picker"
            >
              <span class="i-carbon-face-add text-xl"></span>
            </button>
            {#if showEmojiPicker}
              <EmojiPicker
                onselect={(emoji) => { messageText += emoji; inputRef?.focus() }}
                onclose={() => showEmojiPicker = false}
              />
            {/if}
          </div>
        {/if}

        <!-- Attachment button -->
        <button
          class="w-11 h-11 p-0 flex items-center justify-center flex-shrink-0 text-gray-400 hover:text-white hover:bg-surface-light rounded-full transition-colors"
          onclick={() => fileInputRef?.click()}
          disabled={!canAttach || uploadingAttachments}
          aria-label="Attach file"
        >
          <span class="i-carbon-attachment text-xl"></span>
        </button>

        <!-- svelte-ignore a11y_autofocus -->
        <textarea
          bind:this={inputRef}
          bind:value={messageText}
          onkeydown={handleKeydown}
          onpaste={handlePaste}
          oninput={handleTypingInput}
          placeholder="Type a message..."
          class="input-field flex-1 resize-none min-h-[44px] max-h-32 py-3"
          rows="1"
          autofocus
        ></textarea>

        <!-- Voice/Send button -->
        {#if messageText.trim() || $attachmentDraft.length}
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
            onclick={startVoiceRecording}
            disabled={!canAttach || uploadingAttachments}
            aria-label="Record voice message"
          >
            <span class="i-carbon-microphone text-xl"></span>
          </button>
        {/if}
      {/if}
    </div>
  </div>
</div>

<!-- Disappearing Messages Modal -->
{#if showDisappearingModal}
  <DisappearingMessagesModal
    currentTtlSeconds={currentTtl}
    onclose={() => showDisappearingModal = false}
    onselect={handleSetDisappearing}
  />
{/if}

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

{#if showMuteModal}
  <ChatMuteModal chatId={chat.id} onclose={() => showMuteModal = false} />
{/if}
