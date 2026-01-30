<script lang="ts">
  import { chats, type ChatSession } from '../lib/chat'
  import { createGroup, type Group } from '../lib/groups'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'

  interface Props {
    onBack: () => void
    onGroupCreated: (group: Group) => void
  }

  let { onBack, onGroupCreated }: Props = $props()

  let step = $state<1 | 2>(1)
  let selectedMembers = $state<Set<string>>(new Set())
  let groupName = $state('')

  let availableContacts = $derived(
    Array.from($chats.values()).sort((a, b) => {
      const aTime = a.messages[a.messages.length - 1]?.timestamp || 0
      const bTime = b.messages[b.messages.length - 1]?.timestamp || 0
      return bTime - aTime
    })
  )

  function toggleMember(pubkey: string) {
    const next = new Set(selectedMembers)
    if (next.has(pubkey)) {
      next.delete(pubkey)
    } else {
      next.add(pubkey)
    }
    selectedMembers = next
  }

  function handleNext() {
    if (selectedMembers.size > 0) {
      step = 2
    }
  }

  function handleCreate() {
    const name = groupName.trim()
    if (!name || selectedMembers.size === 0) return

    const group = createGroup(name, Array.from(selectedMembers))
    onGroupCreated(group)
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (step === 1) handleNext()
      else handleCreate()
    }
  }
</script>

<div class="flex-1 flex flex-col min-h-0">
  <!-- Header -->
  <header class="h-16 px-4 flex items-center gap-3 border-b border-surface-lighter flex-shrink-0 bg-[#0a0a0a]">
    <button
      class="btn-ghost p-2 rounded-full"
      onclick={() => step === 2 ? step = 1 : onBack()}
      aria-label="Back"
    >
      <span class="i-carbon-arrow-left text-xl"></span>
    </button>
    <h2 class="font-medium">{step === 1 ? 'Select Members' : 'Group Details'}</h2>
  </header>

  {#if step === 1}
    <!-- Step 1: Select members -->
    <div class="flex-1 overflow-y-auto overscroll-contain">
      {#if availableContacts.length === 0}
        <div class="text-center py-8 px-4">
          <div class="i-carbon-group text-4xl text-gray-600 mx-auto mb-2"></div>
          <p class="text-gray-400 text-sm">No contacts with existing chats</p>
          <p class="text-gray-500 text-xs mt-1">Start 1:1 chats first to add members</p>
        </div>
      {:else}
        {#each availableContacts as contact (contact.id)}
          <button
            class="w-full p-3 hover:bg-surface-light flex items-center gap-3 transition-colors text-left"
            onclick={() => toggleMember(contact.recipientPubkey)}
          >
            <div class="relative">
              <Avatar pubkey={contact.recipientPubkey} size={48} />
              {#if selectedMembers.has(contact.recipientPubkey)}
                <div class="absolute -bottom-0.5 -right-0.5 w-5 h-5 bg-primary rounded-full flex items-center justify-center">
                  <span class="i-carbon-checkmark text-white text-xs"></span>
                </div>
              {/if}
            </div>
            <div class="flex-1 min-w-0">
              <span class="font-medium text-sm"><Name pubkey={contact.recipientPubkey} /></span>
            </div>
          </button>
        {/each}
      {/if}
    </div>

    <!-- Next button -->
    <div class="p-4 border-t border-surface-lighter flex-shrink-0">
      <button
        class="btn-primary w-full"
        disabled={selectedMembers.size === 0}
        onclick={handleNext}
      >
        Next ({selectedMembers.size} selected)
      </button>
    </div>
  {:else}
    <!-- Step 2: Group details -->
    <div class="flex-1 overflow-y-auto overscroll-contain p-4">
      <div class="mb-6">
        <label for="group-name" class="block text-sm text-gray-400 mb-2">Group Name</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="group-name"
          bind:value={groupName}
          onkeydown={handleKeydown}
          placeholder="Enter group name..."
          class="input-field w-full"
          autofocus
        />
      </div>

      <div>
        <p class="text-sm text-gray-400 mb-2">Members ({selectedMembers.size})</p>
        <div class="flex flex-wrap gap-2">
          {#each Array.from(selectedMembers) as pubkey (pubkey)}
            <div class="flex items-center gap-2 bg-surface-light rounded-full pl-1 pr-3 py-1">
              <Avatar {pubkey} size={24} />
              <span class="text-sm"><Name {pubkey} /></span>
              <button
                class="w-5 h-5 rounded-full hover:bg-surface flex items-center justify-center text-gray-400 hover:text-white transition-colors"
                onclick={() => toggleMember(pubkey)}
                aria-label="Remove member"
              >
                <span class="i-carbon-close text-xs"></span>
              </button>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- Create button -->
    <div class="p-4 border-t border-surface-lighter flex-shrink-0">
      <button
        class="btn-primary w-full"
        disabled={!groupName.trim() || selectedMembers.size === 0}
        onclick={handleCreate}
      >
        Create Group
      </button>
    </div>
  {/if}
</div>
