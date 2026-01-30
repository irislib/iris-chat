<script lang="ts">
  import { type ChatSession, chats } from '../lib/chat'
  import ChatView from './ChatView.svelte'
  import NewChat from './NewChat.svelte'
  import JoinChat from './JoinChat.svelte'

  interface Props {
    chat: ChatSession | null
    onChatJoined: (event: CustomEvent<{ chat: ChatSession }>) => void
    onBack: () => void
    showBackButton: boolean
    onViewProfile?: (pubkey: string) => void
    onCreateGroup?: () => void
  }

  let { chat, onChatJoined, onBack, showBackButton, onViewProfile, onCreateGroup }: Props = $props()

  let hasChats = $derived($chats.size > 0)
</script>

<div class="flex-1 flex flex-col min-h-0">
  {#if chat}
    <ChatView {chat} onleave={onBack} {showBackButton} {onViewProfile} />
  {:else}
    <!-- Home / Welcome screen -->
    <div class="flex-1 flex flex-col min-h-0">
      <!-- Header for mobile back -->
      {#if showBackButton}
        <header class="h-16 px-4 flex items-center gap-3 border-b border-surface-lighter flex-shrink-0 md:hidden">
          <button
            class="btn-ghost p-2 rounded-full"
            onclick={onBack}
            aria-label="Back"
          >
            <span class="i-carbon-arrow-left text-xl"></span>
          </button>
          <h2 class="font-medium">Start a chat</h2>
        </header>
      {/if}

      <div class="flex-1 overflow-y-auto overscroll-contain overflow-x-hidden p-4 flex items-center justify-center">
        <div class="w-full max-w-3xl">
          <div class="flex flex-wrap justify-center gap-6">
            <NewChat onjoin={onChatJoined} />
            <JoinChat onjoin={onChatJoined} />
            {#if hasChats && onCreateGroup}
              <div class="w-full max-w-md p-6 bg-surface rounded-2xl shadow-xl overflow-hidden">
                <h2 class="text-2xl font-bold text-white mb-4 text-center">Create Group</h2>
                <p class="text-gray-400 text-center text-sm mb-4">
                  Start a group chat with your existing contacts
                </p>
                <button
                  class="btn-primary w-full flex items-center justify-center gap-2"
                  onclick={onCreateGroup}
                >
                  <span class="i-carbon-group"></span>
                  Create Group
                </button>
              </div>
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
