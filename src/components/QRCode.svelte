<script lang="ts">
  import { onMount } from 'svelte'

  interface Props {
    data: string
    size?: number
  }

  let { data, size = 200 }: Props = $props()

  let qrCodeUrl = $state('')

  onMount(async () => {
    try {
      const QRCode = await import('qrcode')
      qrCodeUrl = await QRCode.toDataURL(data, {
        width: size,
        margin: 0,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      })
    } catch (e) {
      console.error('Failed to generate QR code:', e)
    }
  })

  // Regenerate when data changes
  $effect(() => {
    if (data) {
      import('qrcode').then(QRCode => {
        QRCode.toDataURL(data, {
          width: size,
          margin: 0,
          color: {
            dark: '#000000',
            light: '#ffffff',
          },
        }).then(url => {
          qrCodeUrl = url
        })
      })
    }
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
