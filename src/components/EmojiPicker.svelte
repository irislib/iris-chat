<script lang="ts">
  let {
    onselect,
    onclose,
    openUp = true,
    openLeft = false,
  }: {
    onselect: (emoji: string) => void
    onclose: () => void
    openUp?: boolean
    openLeft?: boolean
  } = $props()

  let activeCategory = $state(0)
  let pickerRef = $state<HTMLDivElement>()

  const categories = [
    { name: 'Smileys', icon: '😀', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
    { name: 'Gestures', icon: '👋', emojis: ['👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄'] },
    { name: 'Hearts', icon: '❤️', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️','💋','💌','💐','🌹','🥀','🌷','🌸','💮','🏵️','🌻','🌼','🌺'] },
    { name: 'People', icon: '👤', emojis: ['👶','👧','🧒','👦','👩','🧑','👨','👩‍🦱','🧑‍🦱','👨‍🦱','👩‍🦰','🧑‍🦰','👨‍🦰','👱‍♀️','👱','👱‍♂️','👩‍🦳','🧑‍🦳','👨‍🦳','👩‍🦲','🧑‍🦲','👨‍🦲','🧔‍♀️','🧔','🧔‍♂️','👵','🧓','👴','👲','👳‍♀️','👳','👳‍♂️','🧕','👮‍♀️','👮','👮‍♂️','👷‍♀️','👷','👷‍♂️','💂‍♀️','💂','💂‍♂️','🕵️‍♀️','🕵️','🕵️‍♂️','🧑‍⚕️','👩‍🌾','🧑‍🍳','🧑‍🎓','🧑‍🎤','🧑‍💻','🧑‍🚀','🧑‍🚒','🧙','🧝','🧛','🧟','🧞','🧜','🧚'] },
    { name: 'Animals', icon: '🐶', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬'] },
    { name: 'Food', icon: '🍕', emojis: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🍆','🌶️','🫑','🥒','🥬','🥦','🧄','🧅','🍄','🥜','🫘','🌰','🍞','🥐','🥖','🫓','🥨','🥯','🥞','🧇','🧀','🍖','🍗','🥩','🥓','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🫔','🥙','🧆','🥚','🍳','🥘','🍲','🫕','🥣','🥗','🍿','🧈','🧂','🥫','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🍡','🥟','🥠','🥡'] },
    { name: 'Travel', icon: '🚗', emojis: ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🏍️','🛵','🚲','🛴','🛹','🛼','🚁','✈️','🛩️','🚀','🛸','🚢','⛵','🚤','🛥️','🛳️','⛴️','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','🚊','🚝','🚞','🚋','🚏','🗼','🗽','🏰','🏯','🏟️','🎡','🎢','🎠','⛲','⛱️','🏖️','🏝️','🏜️','🌋','⛰️','🏔️','🗻','🏕️','🏠','🏡','🏘️','🏚️'] },
    { name: 'Objects', icon: '💡', emojis: ['⌚','📱','💻','⌨️','🖥️','🖨️','🖱️','🖲️','💾','💿','📀','🎥','📷','📸','📹','📼','🔍','🔎','🕯️','💡','🔦','🏮','📔','📕','📖','📗','📘','📙','📚','📓','📒','📃','📜','📄','📰','📑','🔖','💰','🪙','💴','💵','💶','💷','💸','💳','🧾','✉️','📧','📨','📩','📤','📥','📦','📫','📪','📬','📭','📮','🗳️','✏️','✒️','🖊️','🖋️','📝','🔑','🗝️','🔒','🔓'] },
    { name: 'Symbols', icon: '⭐', emojis: ['⭐','🌟','✨','⚡','🔥','💥','☀️','🌤️','⛅','🌦️','🌈','☁️','🌧️','⛈️','🌩️','❄️','☃️','⛄','🌬️','💨','🌪️','🌫️','🌊','💧','💦','☔','🎵','🎶','🎼','🎹','🥁','🎸','🎺','🎻','🎷','🪗','✅','❌','❓','❗','‼️','⁉️','💯','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔶','🔷','♾️','💬','💭','🗯️','♠️','♣️','♥️','♦️','🎲','🏆','🥇','🥈','🥉','🏅','🎖️','🎗️','🎪','🎭','🎨'] },
    { name: 'Flags', icon: '🏁', emojis: ['🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🇺🇸','🇬🇧','🇫🇷','🇩🇪','🇯🇵','🇨🇳','🇰🇷','🇮🇳','🇧🇷','🇷🇺','🇮🇹','🇪🇸','🇨🇦','🇦🇺','🇲🇽','🇳🇱','🇸🇪','🇳🇴','🇩🇰','🇫🇮','🇵🇱','🇺🇦','🇹🇷','🇸🇦','🇦🇪','🇹🇭','🇻🇳','🇮🇩','🇵🇭','🇸🇬','🇲🇾','🇳🇿','🇿🇦','🇪🇬','🇳🇬','🇰🇪','🇦🇷','🇨🇱','🇨🇴','🇵🇪'] },
  ]

  const quickEmojis = ['❤️', '👍', '😂', '😮', '😢', '🙏']

  function handleClickOutside(e: MouseEvent) {
    if (pickerRef && !pickerRef.contains(e.target as Node)) {
      onclose()
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
  }

  $effect(() => {
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeydown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeydown)
    }
  })
</script>

<div
  bind:this={pickerRef}
  class="absolute {openLeft ? 'right-0' : 'left-0'} {openUp ? 'bottom-full mb-1' : 'top-full mt-1'} w-72 bg-surface-light rounded-xl border border-surface-lighter shadow-xl flex flex-col z-50 overflow-hidden {openUp ? 'max-h-80' : 'max-h-80'}"
>
  <!-- Quick reaction row -->
  <div class="flex items-center gap-1 px-2 py-1.5 border-b border-surface-lighter">
    {#each quickEmojis as emoji}
      <button
        class="w-9 h-9 rounded-full hover:bg-surface-lighter flex items-center justify-center text-xl transition-colors"
        onclick={() => onselect(emoji)}
      >
        {emoji}
      </button>
    {/each}
  </div>

  <!-- Category tabs -->
  <div class="flex border-b border-surface-lighter overflow-x-auto px-1 flex-shrink-0">
    {#each categories as cat, i}
      <button
        class="px-1.5 py-1 text-base hover:bg-surface-lighter rounded-lg transition-colors flex-shrink-0 {activeCategory === i ? 'bg-surface-lighter' : ''}"
        onclick={() => activeCategory = i}
        title={cat.name}
      >
        {cat.icon}
      </button>
    {/each}
  </div>

  <!-- Emoji grid -->
  <div class="flex-1 overflow-y-auto p-2">
    <div class="text-xs text-gray-400 px-1 pb-1">{categories[activeCategory].name}</div>
    <div class="grid grid-cols-8 gap-0.5">
      {#each categories[activeCategory].emojis as emoji}
        <button
          class="w-8 h-8 flex items-center justify-center text-lg hover:bg-surface-lighter rounded cursor-pointer transition-colors"
          onclick={() => onselect(emoji)}
        >
          {emoji}
        </button>
      {/each}
    </div>
  </div>
</div>
