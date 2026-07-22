<script lang="ts">
  interface Props {
    data: string
    size?: number
  }

  let { data, size = 200 }: Props = $props()

  let qrCodeUrl = $state('')

  $effect(() => {
    const value = data
    const width = size
    let cancelled = false
    async function generate() {
      try {
        const QRCode = await import('qrcode')
        const url = await QRCode.toDataURL(value, {
          width,
          margin: 0,
          color: {
            dark: '#000000',
            light: '#ffffff',
          },
        })
        if (!cancelled) qrCodeUrl = url
      } catch (e) {
        console.error('Failed to generate QR code:', e)
      }
    }

    if (value) void generate()
    return () => { cancelled = true }
  })
</script>

{#if qrCodeUrl}
  <img
    src={qrCodeUrl}
    alt="QR Code"
    width={size}
    height={size}
    class="block"
  />
{:else}
  <div
    class="bg-gray-200 animate-pulse"
    style="width: {size}px; height: {size}px;"
  ></div>
{/if}
