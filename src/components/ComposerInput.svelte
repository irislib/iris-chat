<script lang="ts">
  import { nip19 } from 'nostr-tools'
  import { mentionNames } from '../lib/mentionNames'
  import { decodeDraft, editDraft, encodeDraft, insertCompletion, completionAt, emojiSuggestions, exactEmoji, ComposerHistory, composerSnapshot, type ComposerSnapshot, type DraftEditRange, type Completion, type ComposerDraft } from '../lib/composerCompletion'

  let { value = $bindable(''), inputRef = $bindable<HTMLTextAreaElement | null>(null), members = [], disabled = false, onkeydown, onpaste, oninput }:
    { value?: string; inputRef?: HTMLTextAreaElement | null; members?: string[]; disabled?: boolean; onkeydown?: (event: KeyboardEvent) => void; onpaste?: (event: ClipboardEvent) => void; oninput?: () => void } = $props()
  const menuId = $props.id()
  let names = $derived(mentionNames(members))
  let draft = $state<ComposerDraft>({ text: '', mentions: [] })
  let ownWire = $state('')
  let completion = $state<Completion | undefined>()
  let selected = $state(0)
  let composing = false
  let applying = false
  const history = new ComposerHistory()
  let pending: { before: ComposerSnapshot; range: DraftEditRange } | undefined
  let composition: ComposerSnapshot | undefined
  let memberContext = ''
  const snapshot = () => composerSnapshot(draft,inputRef?.selectionStart ?? draft.text.length,inputRef?.selectionEnd ?? draft.text.length)
  function resetHistory() { history.clear(); pending = undefined; composition = undefined }
  $effect(() => {
    const context = members.join(',')
    if (context !== memberContext) { memberContext = context; resetHistory() }
  })
  let rows = $derived(completion?.kind === 'mention'
    ? Object.entries($names).filter(([, name]) => name.toLocaleLowerCase().includes(completion!.query.toLocaleLowerCase())).slice(0, 6).map(([pubkey,name]) => {
      const duplicate = Object.values($names).filter(value => value.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()).length > 1
      const npub = duplicate ? nip19.npubEncode(pubkey) : ''
      return { label: '@' + name, detail: duplicate ? npub.slice(0,12) + '…' + npub.slice(-6) : '', pubkey }
    })
    : completion?.kind === 'emoji' && !completion.closed ? emojiSuggestions(completion.query).map(item => ({ label: item.emoji, detail: ':' + item.aliases[0] + ':', pubkey: undefined })) : [])
  $effect(() => {
    const wire = value
    if (wire !== ownWire) { draft = decodeDraft(wire, $names); ownWire = wire; completion = undefined; resetHistory() }
  })
  function publish() { ownWire = encodeDraft(draft); value = ownWire; oninput?.() }
  function dismiss() { completion = undefined; selected = 0 }
  function findCompletion() {
    const input = inputRef
    if (!input || composing || disabled) { dismiss(); return }
    completion = completionAt(draft.text, input.selectionStart, input.selectionEnd)
    if (completion && draft.mentions.some(m => completion!.start >= m.start && completion!.start < m.end)) completion = undefined
    selected = 0
  }
  function writeEditor(start: number, end = start) {
    if (!inputRef) return
    applying = true
    inputRef.value = draft.text
    inputRef.focus(); inputRef.setSelectionRange(start,end)
    queueMicrotask(() => { applying = false })
  }
  function restore(state: ComposerSnapshot | undefined) {
    if (!state) {
      // A browser command may mutate its native buffer after our draft was reset.
      if (inputRef) writeEditor(Math.min(inputRef.selectionStart,draft.text.length),Math.min(inputRef.selectionEnd,draft.text.length))
      return
    }
    draft = composerSnapshot(state.draft,state.start,state.end).draft
    pending = undefined; dismiss(); publish(); writeEditor(state.start,state.end)
  }
  function replace(label: string, pubkey?: string, trailingSpace = true) {
    if (!completion || !inputRef) return
    const before = snapshot()
    const caret = completion.start + label.length + (trailingSpace ? 1 : 0)
    draft = insertCompletion(draft, completion.start, completion.end, label, pubkey, trailingSpace)
    history.record(before,composerSnapshot(draft,caret))
    pending = undefined; dismiss(); publish(); writeEditor(caret)
  }
  function beforeInput(event: InputEvent) {
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      if (event.cancelable) {
        event.preventDefault()
        restore(event.inputType === 'historyUndo' ? history.undo() : history.redo())
      }
      return
    }
    const before = snapshot()
    pending = { before, range:{start:before.start,end:before.end,inputType:event.inputType} }
  }
  function input(event: Event) {
    const inputType = (event as InputEvent).inputType
    if (inputType === 'historyUndo' || inputType === 'historyRedo') {
      restore(inputType === 'historyUndo' ? history.undo() : history.redo())
      return
    }
    const target = event.currentTarget as HTMLTextAreaElement
    const before = composition ?? pending?.before ?? snapshot()
    const range = composition ? {start:composition.start,end:composition.end,inputType:'insertCompositionText'} : pending?.range
    draft = editDraft(before.draft,target.value,range)
    pending = undefined
    if (!composing) history.record(before,composerSnapshot(draft,target.selectionStart,target.selectionEnd))
    publish(); findCompletion()
    if (!composing && completion?.kind === 'emoji' && completion.closed) {
      const emoji = exactEmoji(completion.query)
      if (emoji) replace(emoji,undefined,false)
    }
  }
  function startComposition() { composition = snapshot(); pending = undefined; composing = true; dismiss() }
  function endComposition() {
    if (composition) history.record(composition,snapshot())
    composition = undefined; pending = undefined; composing = false; findCompletion()
  }
  function keydown(event: KeyboardEvent) {
    if (event.isComposing || composing || event.keyCode === 229) return
    if ((event.metaKey || event.ctrlKey) && !event.altKey && ['z','y'].includes(event.key.toLowerCase())) {
      event.preventDefault()
      restore(event.key.toLowerCase() === 'y' || event.shiftKey ? history.redo() : history.undo())
      return
    }
    if (completion && rows.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); selected = (selected + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length; return }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); const row = rows[selected] ?? rows[0]; void replace(row.label,row.pubkey); return }
      if (event.key === 'Escape') { event.preventDefault(); dismiss(); return }
    }
    if (['ArrowLeft','ArrowRight','Home','End','Escape'].includes(event.key)) dismiss()
    onkeydown?.(event)
  }
</script>

<div class="relative flex-1 min-w-0">
  {#if completion && rows.length && !disabled}
    <div id={menuId} role="listbox" aria-label={completion.kind === 'mention' ? 'Mention someone' : 'Emoji suggestions'} class="absolute bottom-full mb-2 left-0 right-0 z-30 bg-surface rounded-xl shadow-xl p-1 max-h-64 overflow-y-auto">
      {#each rows as row, i}
        <button id={`${menuId}-${i}`} type="button" role="option" aria-selected={i === selected} aria-label={row.detail ? `${row.label}, ${row.detail}` : row.label}
          class="w-full text-left px-3 py-2 rounded-lg flex items-center gap-3" class:bg-surface-light={i === selected}
          onpointerdown={event => event.preventDefault()} onclick={() => replace(row.label,row.pubkey)}>
          <span class:text-xl={completion.kind === 'emoji'} class="truncate">{row.label}</span>
          {#if row.detail}<span class="text-gray-400 truncate text-sm">{row.detail}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
  <!-- svelte-ignore a11y_autofocus -->
  <textarea bind:this={inputRef} value={draft.text} {disabled} placeholder="Type a message..." rows="1" autofocus
    class="input-field w-full resize-none min-h-[44px] max-h-32 py-3 block"
    aria-autocomplete="list" aria-controls={completion && rows.length ? menuId : undefined}
    aria-activedescendant={completion && rows.length ? `${menuId}-${selected}` : undefined}
    onbeforeinput={beforeInput} oninput={input} onkeydown={keydown} {onpaste} onblur={dismiss} onclick={dismiss}
    onselect={() => { if (!applying && inputRef && completion && (inputRef.selectionStart !== completion.end || inputRef.selectionEnd !== completion.end)) dismiss() }}
    oncompositionstart={startComposition} oncompositionend={endComposition}
  ></textarea>
</div>
