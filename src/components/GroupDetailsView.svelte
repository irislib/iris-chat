<script lang="ts">
  import { liveQuery } from 'dexie'
  import { createGroupInvite, groupInviteLinks, revokeGroupInvite, type GroupInviteGrant } from '../lib/groupInvites'
  import CopyButton from './CopyButton.svelte'
  import QRCode from './QRCode.svelte'
  import ChatPinButton from './ChatPinButton.svelte'
  import { groups, deleteGroup, isAdmin, canSendToGroup, addGroupMember, removeGroupMember, updateGroupInfo, addGroupAdmin, removeGroupAdmin, type Group } from '../lib/groups'
  import { chats } from '../lib/chat'
  import { getPubkey } from '../lib/identity'
  import { uploadFile, getMediaUrl, parseFileLink, isImageFile } from '../lib/hashtree'
  import { mediaModal, openMediaModal, closeMediaModal } from '../lib/mediaModal'
  import MediaModal from './MediaModal.svelte'
  import { getErrorMessage } from '../lib/utils'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  import GroupAvatar from './GroupAvatar.svelte'

  interface Props {
    group: Group
    onBack: () => void
    onDeleted: () => void
    onViewProfile?: (pubkey: string) => void
  }

  let { group: initialGroup, onBack, onDeleted, onViewProfile }: Props = $props()

  // Read live group state from store
  let group = $derived($groups.get(initialGroup.id) || initialGroup)
  let myPubkey = $derived(getPubkey() || '')
  let amAdmin = $derived(canSendToGroup(group, myPubkey) && isAdmin(group, myPubkey))

  let editingName = $state(false)
  let editNameValue = $state('')
  let showAddMember = $state(false)
  let confirmingDelete = $state(false)
  let uploadingPicture = $state(false)
  let uploadProgress = $state(0)
  let pictureError = $state('')
  let showInvites = $state(false)
  let inviteLinks = $state<GroupInviteGrant[]>([])
  let creatingInvite = $state(false)
  let inviteError = $state('')
  let maxUses = $state(0)
  let expiryDays = $state(30)
  let qrReference = $state('')
  $effect(() => {
    const groupId = group.id
    if (!showInvites) return
    const subscription = liveQuery(() => groupInviteLinks(groupId)).subscribe({
      next: links => { inviteLinks = links },
      error: error => { inviteError = getErrorMessage(error, 'Could not load invites') },
    })
    return () => subscription.unsubscribe()
  })
  function openInvites() { showInvites = !showInvites }
  async function revokeLink(link: GroupInviteGrant) {
    inviteError = ''
    try { await revokeGroupInvite(link) }
    catch (error) { inviteError = getErrorMessage(error, 'Could not revoke invite') }
  }
  async function createLink() {
    creatingInvite = true; inviteError = ''
    try {
      await createGroupInvite(group.id, maxUses || undefined, expiryDays ? Math.floor(Date.now() / 1000) + expiryDays * 86400 : undefined)
    } catch (error) { inviteError = getErrorMessage(error, 'Could not create invite') }
    finally { creatingInvite = false }
  }

  // Contacts that can be added (have chat sessions, not already members)
  let addableContacts = $derived(
    Array.from($chats.values())
      .filter(c => !group.members.includes(c.recipientPubkey))
      .sort((a, b) => {
        const aTime = a.messages[a.messages.length - 1]?.timestamp || 0
        const bTime = b.messages[b.messages.length - 1]?.timestamp || 0
        return bTime - aTime
      })
  )

  function handleDelete() {
    deleteGroup(group.id)
    onDeleted()
  }

  function startEditName() {
    editNameValue = group.name
    editingName = true
  }

  function saveName() {
    const name = editNameValue.trim()
    if (name && name !== group.name) {
      updateGroupInfo(group.id, { name })
    }
    editingName = false
  }

  function handleNameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') saveName()
    else if (e.key === 'Escape') editingName = false
  }

  function handleAddMember(pubkey: string) {
    addGroupMember(group.id, pubkey)
    showAddMember = false
  }

  function handleRemoveMember(pubkey: string) {
    removeGroupMember(group.id, pubkey)
  }

  function handleToggleAdmin(pubkey: string) {
    if (group.admins.includes(pubkey)) {
      removeGroupAdmin(group.id, pubkey)
    } else {
      addGroupAdmin(group.id, pubkey)
    }
  }

  let fileInputRef = $state<HTMLInputElement | null>(null)

  async function handlePictureSelect(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    input.value = ''

    uploadingPicture = true
    uploadProgress = 0
    pictureError = ''
    try {
      const { nhash } = await uploadFile(file, (bytesUploaded, totalBytes) => {
        uploadProgress = Math.round((bytesUploaded / totalBytes) * 100)
      }, { requireRemote: true })
      // Verify the image is retrievable before setting it
      await getMediaUrl(nhash, file.type || 'image/*')
      const filename = encodeURIComponent(file.name)
      const pictureUri = `nhash://${nhash}/${filename}`
      updateGroupInfo(group.id, { picture: pictureUri })
    } catch (e) {
      pictureError = getErrorMessage(e, 'Upload failed')
    } finally {
      uploadingPicture = false
    }
  }
</script>

<div class="flex-1 flex flex-col min-h-0">
  <!-- Header -->
  <header class="h-16 px-4 flex items-center gap-3 border-b border-surface-lighter flex-shrink-0 bg-panel">
    <button
      class="chat-header-button"
      onclick={onBack}
      aria-label="Back"
    >
      <span class="i-carbon-arrow-left text-xl"></span>
    </button>
    <h2 class="font-medium">Group Info</h2>
  </header>

  <div class="flex-1 overflow-y-auto overscroll-contain">
    <div class="px-4 py-2"><ChatPinButton chatId={`group:${group.id}`} /></div>
    <!-- Group info -->
    <div class="p-6 flex flex-col items-center border-b border-surface-lighter">
      <!-- Group picture -->
      <input
        bind:this={fileInputRef}
        type="file"
        class="hidden"
        accept="image/*"
        onchange={handlePictureSelect}
      />
      <div class="relative mb-3 group/pic">
        <button
          onclick={() => {
            if (!group.picture) return
            const stripped = group.picture.replace(/^nhash:\/\//, '')
            const parsed = parseFileLink(stripped)
            if (parsed && isImageFile(parsed.filename)) {
              getMediaUrl(parsed.nhash, 'image/*').then(url => {
                openMediaModal(url, parsed.filename, 'image')
              })
            }
          }}
          disabled={!group.picture}
          aria-label="View group picture"
          class="cursor-pointer"
        >
          <GroupAvatar picture={group.picture} size={80} />
        </button>
        {#if amAdmin}
          <button
            class="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-surface-light border border-surface-lighter flex items-center justify-center text-gray-400 hover:text-white hover:bg-primary transition-colors"
            onclick={() => fileInputRef?.click()}
            disabled={uploadingPicture}
            aria-label="Change group picture"
          >
            {#if uploadingPicture}
              <span class="text-xs font-medium">{uploadProgress}%</span>
            {:else}
              <span class="i-carbon-camera text-sm"></span>
            {/if}
          </button>
        {/if}
      </div>
      {#if pictureError}
        <p class="text-xs text-red-400 mb-2">{pictureError}</p>
      {/if}

      <!-- Group name -->
      {#if editingName}
        <div class="flex items-center gap-2 w-full max-w-xs">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:value={editNameValue}
            onkeydown={handleNameKeydown}
            class="input-field flex-1 text-center"
            autofocus
          />
          <button
            class="btn-ghost p-2 text-green-400"
            onclick={saveName}
            aria-label="Save"
          >
            <span class="i-carbon-checkmark"></span>
          </button>
          <button
            class="btn-ghost p-2 text-red-400"
            onclick={() => editingName = false}
            aria-label="Cancel"
          >
            <span class="i-carbon-close"></span>
          </button>
        </div>
      {:else}
        <button
          class="flex items-center gap-2 hover:opacity-80 transition-opacity"
          onclick={startEditName}
          disabled={!amAdmin}
        >
          <h3 class="text-xl font-semibold">{group.name}</h3>
          {#if amAdmin}
            <span class="i-carbon-edit text-gray-500 text-sm"></span>
          {/if}
        </button>
      {/if}
      <p class="text-sm text-gray-500 mt-1">{group.members.length} members</p>
    </div>

    {#if amAdmin}
      <div class="p-4 border-b border-surface-lighter">
        <button class="btn-secondary w-full" onclick={openInvites}>Invite link</button>
        {#if showInvites}
          <div class="flex flex-col gap-3 mt-4">
            {#each inviteLinks as link (link.reference)}
              <div class="p-3 rounded-lg bg-surface-light space-y-2">
                <CopyButton text={`https://chat.iris.to/#/${link.reference}`} maxLength={32} />
                <p class="text-xs text-gray-400">{link.usedBy.length} joined{link.record.maxUses ? ` · Limit ${link.record.maxUses}` : ''}{link.record.expiresAt ? ` · Expires ${new Date(link.record.expiresAt * 1000).toLocaleDateString()}` : ''}</p>
                <div class="flex gap-4 text-sm">
                  <button onclick={() => qrReference = qrReference === link.reference ? '' : link.reference}>Show QR</button>
                  <button class="text-red-400" onclick={() => revokeLink(link)}>Revoke</button>
                </div>
                {#if qrReference === link.reference}<div class="bg-white p-3 w-fit rounded-lg"><QRCode data={`https://chat.iris.to/#/${link.reference}`} size={220} /></div>{/if}
              </div>
            {/each}
            <label class="text-sm text-gray-400">Use limit
              <select class="input w-full mt-1" bind:value={maxUses}><option value={0}>No limit</option><option value={1}>1 person</option><option value={10}>10 people</option><option value={100}>100 people</option></select>
            </label>
            <label class="text-sm text-gray-400">Expires
              <select class="input w-full mt-1" bind:value={expiryDays}><option value={30}>In 30 days</option><option value={7}>In 7 days</option><option value={0}>Never</option></select>
            </label>
            {#if inviteError}<p role="alert" class="text-sm text-red-400">{inviteError}</p>{/if}
            <button class="btn-primary" disabled={creatingInvite} onclick={createLink}>{creatingInvite ? 'Creating invite…' : 'Create invite link'}</button>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Members list -->
    <div class="p-4">
      <div class="flex items-center justify-between mb-3">
        <h4 class="text-sm text-gray-400 font-medium">Members</h4>
        {#if amAdmin}
          <button
            class="text-sm text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
            onclick={() => showAddMember = !showAddMember}
          >
            <span class="i-carbon-add text-xs"></span>
            Add
          </button>
        {/if}
      </div>

      <!-- Add member panel -->
      {#if showAddMember}
        <div class="mb-3 border border-surface-lighter rounded-lg overflow-hidden">
          {#if addableContacts.length === 0}
            <p class="text-sm text-gray-500 p-3 text-center">No contacts available to add</p>
          {:else}
            {#each addableContacts as contact (contact.id)}
              <button
                class="w-full p-3 hover:bg-surface-light flex items-center gap-3 transition-colors text-left"
                onclick={() => handleAddMember(contact.recipientPubkey)}
              >
                <Avatar pubkey={contact.recipientPubkey} size={36} />
                <span class="text-sm"><Name pubkey={contact.recipientPubkey} /></span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}

      {#each group.members as pubkey (pubkey)}
        <div class="w-full p-3 flex items-center gap-3 rounded-lg">
          <button
            class="flex items-center gap-3 flex-1 min-w-0 hover:opacity-80 transition-opacity text-left"
            onclick={() => onViewProfile?.(pubkey)}
            disabled={!onViewProfile}
          >
            <Avatar {pubkey} size={40} />
            <div class="flex-1 min-w-0">
              <span class="font-medium text-sm"><Name {pubkey} /></span>
              {#if group.admins.includes(pubkey)}
                <span class="text-xs text-primary ml-1">admin</span>
              {/if}
            </div>
          </button>
          {#if amAdmin && pubkey !== myPubkey}
            <div class="flex items-center gap-2 flex-shrink-0">
              <button
                class="text-xs px-2 py-1 rounded hover:bg-surface-light text-gray-400 hover:text-white transition-colors"
                onclick={() => handleToggleAdmin(pubkey)}
              >
                {group.admins.includes(pubkey) ? 'Dismiss admin' : 'Make admin'}
              </button>
              <button
                class="text-xs px-2 py-1 rounded hover:bg-red-400/10 text-gray-400 hover:text-red-400 transition-colors"
                onclick={() => handleRemoveMember(pubkey)}
              >
                Remove
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Delete button -->
    <div class="p-4 border-t border-surface-lighter">
      {#if confirmingDelete}
        <p class="text-sm text-gray-400 text-center mb-3">Are you sure you want to delete this group?</p>
        <div class="flex gap-2">
          <button
            class="flex-1 py-3 text-gray-400 hover:bg-surface-light rounded-lg transition-colors"
            onclick={() => confirmingDelete = false}
          >
            Cancel
          </button>
          <button
            class="flex-1 py-3 text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
            onclick={handleDelete}
          >
            Delete
          </button>
        </div>
      {:else}
        <button
          class="w-full py-3 text-red-400 hover:bg-red-400/10 rounded-lg transition-colors flex items-center justify-center gap-2"
          onclick={() => confirmingDelete = true}
        >
          <span class="i-carbon-trash-can"></span>
          Delete Group
        </button>
      {/if}
    </div>
  </div>
</div>

{#if $mediaModal.open}
  <MediaModal
    src={$mediaModal.src}
    nhash={$mediaModal.nhash}
    filename={$mediaModal.filename}
    type={$mediaModal.type}
    onclose={closeMediaModal}
  />
{/if}
