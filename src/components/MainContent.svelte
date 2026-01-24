<script lang="ts">
  import { type ChatSession } from '../lib/chat'
  import ChatView from './ChatView.svelte'
  import NewChat from './NewChat.svelte'
  import JoinChat from './JoinChat.svelte'

  interface Props {
    chat: ChatSession | null
    onChatJoined: (event: CustomEvent<{ chat: ChatSession }>) => void
    onBack: () => void
    showBackButton: boolean
  }

  let { chat, onChatJoined, onBack, showBackButton }: Props = $props()
</script>

<div class="h-full flex flex-col">
  {#if chat}
    <ChatView {chat} onleave={onBack} {showBackButton} />
  {:else}
    <!-- Home / Welcome screen -->
    <div class="h-full flex flex-col">
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

      <div class="flex-1 overflow-y-auto overflow-x-hidden p-4">
        <div class="w-full max-w-3xl mx-auto space-y-6">
          <div class="grid md:grid-cols-2 gap-6">
            <NewChat onjoin={onChatJoined} />
            <JoinChat onjoin={onChatJoined} />
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
