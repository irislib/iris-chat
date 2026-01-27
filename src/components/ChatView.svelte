<script lang="ts">
  import { onDestroy } from 'svelte'
  import { sendMessage, sendReaction, deleteChat, deleteMessage, type ChatSession, currentChat } from '../lib/chat'
  import { uploadFile, formatFileLink, isImageFile, isVideoFile } from '../lib/hashtree'
  import { mediaModal, closeMediaModal } from '../lib/mediaModal'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  import MessageBubble from './MessageBubble.svelte'
  import MediaModal from './MediaModal.svelte'

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

  let messageText = $state('')
  let messagesContainer = $state<HTMLDivElement | null>(null)
  let inputRef = $state<HTMLTextAreaElement | null>(null)
  let fileInputRef = $state<HTMLInputElement | null>(null)
  let showMenu = $state(false)
  let pendingAttachment = $state<PendingAttachment | null>(null)

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

    messageText = ''
    clearAttachment()

    sendMessage(chat, text)

    requestAnimationFrame(() => inputRef?.focus())
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    } else if (e.key === 'Escape') {
      inputRef?.blur()
    }
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

  // Auto-scroll to bottom when new messages arrive
  $effect(() => {
    if (messagesContainer && $currentChat?.messages.length) {
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

  let messages = $derived($currentChat?.messages || chat.messages)
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
        <MessageBubble {message} {isFirst} {isLast} {prevHasReactions} {hasReactions} onreact={handleReact} ondelete={handleDeleteMessage} />
      {/each}
    {/if}
  </div>

  <!-- Input - flex-shrink-0 keeps it at bottom -->
  <div class="border-t border-surface-lighter flex-shrink-0 bg-[#0a0a0a]">
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
      <button
        class="btn-primary w-11 h-11 p-0 flex items-center justify-center flex-shrink-0"
        onclick={handleSend}
        disabled={!canSend}
        aria-label="Send"
      >
        <span class="i-carbon-send text-xl"></span>
      </button>
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
