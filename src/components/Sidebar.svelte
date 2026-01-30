<script lang="ts">
  import { identity } from '../lib/identity'
  import { chats, type ChatSession } from '../lib/chat'
  import { groups, groupMessages } from '../lib/groups'
  import { relayStore } from '../lib/relayStore'
  import Avatar from './Avatar.svelte'
  import ChatListItem from './ChatListItem.svelte'
  import GroupChatListItem from './GroupChatListItem.svelte'
  import ConnectivityIndicator from './ConnectivityIndicator.svelte'

  interface Props {
    selectedChatId: string | null
    selectedGroupId: string | null
    onSelectChat: (chat: ChatSession) => void
    onSelectGroup: (groupId: string) => void
    onNewChat: () => void
    onSettings: () => void
  }

  let { selectedChatId, selectedGroupId, onSelectChat, onSelectGroup, onNewChat, onSettings }: Props = $props()

  let showConnectivity = $derived($relayStore.showConnectivity)

  // Unified sorted items: DMs and groups merged by last message time
  type SidebarItem =
    | { type: 'dm'; chat: ChatSession; lastTime: number }
    | { type: 'group'; groupId: string; lastTime: number }

  let sortedItems = $derived.by(() => {
    const items: SidebarItem[] = []

    for (const chat of $chats.values()) {
      const lastTime = chat.messages[chat.messages.length - 1]?.timestamp || 0
      items.push({ type: 'dm', chat, lastTime })
    }

    for (const [groupId, group] of $groups.entries()) {
      const msgs = $groupMessages.get(groupId) || []
      const lastTime = msgs[msgs.length - 1]?.timestamp || group.createdAt || 0
      items.push({ type: 'group', groupId, lastTime })
    }

    return items.sort((a, b) => b.lastTime - a.lastTime)
  })
</script>

<div class="h-full flex flex-col bg-surface border-r border-surface-lighter">
  <!-- Header -->
  <header class="h-16 px-4 flex items-center justify-between border-b border-surface-lighter flex-shrink-0">
    <button
      class="flex items-center gap-2 select-none bg-transparent border-none p-0 cursor-pointer hover:opacity-80 transition-opacity"
      onclick={onNewChat}
    >
      <img src="/iris-logo.png" alt="Iris" class="w-8 h-8" draggable="false" />
      <h1 class="text-xl font-bold">
        <span class="text-primary">iris</span> chat
      </h1>
    </button>
    <div class="flex items-center gap-1">
      {#if showConnectivity}
        <ConnectivityIndicator onclick={onSettings} />
      {/if}
      <button
        class="cursor-pointer bg-transparent border-none p-0 hover:opacity-80 transition-opacity"
        onclick={onSettings}
        aria-label="Settings"
      >
        <Avatar pubkey={$identity?.pubkey || ''} size={32} />
      </button>
    </div>
  </header>

  <!-- New Chat Button -->
  <div class="p-3 border-b border-surface-lighter flex-shrink-0">
    <button
      class="btn-primary w-full flex items-center justify-center gap-2"
      onclick={onNewChat}
    >
      <span class="i-carbon-add"></span>
      New Chat
    </button>
  </div>

  <!-- Chat List -->
  <div class="flex-1 overflow-y-auto overscroll-contain">
    {#if sortedItems.length > 0}
      {#each sortedItems as item (item.type === 'dm' ? item.chat.id : item.groupId)}
        {#if item.type === 'dm'}
          <div class="{selectedChatId === item.chat.id ? 'bg-surface-light' : ''}">
            <ChatListItem chat={item.chat} onopen={() => onSelectChat(item.chat)} />
          </div>
        {:else}
          {@const group = $groups.get(item.groupId)}
          {#if group}
            <div class="{selectedGroupId === item.groupId ? 'bg-surface-light' : ''}">
              <GroupChatListItem {group} messages={$groupMessages.get(item.groupId) || []} onopen={() => onSelectGroup(item.groupId)} />
            </div>
          {/if}
        {/if}
      {/each}
    {:else}
      <div class="text-center py-8 px-4">
        <div class="i-carbon-chat text-4xl text-gray-600 mx-auto mb-2"></div>
        <p class="text-gray-400 text-sm">No chats yet</p>
      </div>
    {/if}
  </div>
</div>
