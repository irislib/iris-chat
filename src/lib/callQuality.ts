export type CallQuality = 'auto' | 'high' | 'save' | 'custom'
export interface CallQualitySettings { quality?: CallQuality; customBitrateKbps?: number }
export const callQualityOptions: { value: CallQuality; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'high', label: 'High quality' },
  { value: 'save', label: 'Use less data' },
  { value: 'custom', label: 'Custom' },
]
export function normalizeCallQuality(value: { quality?: unknown; customBitrateKbps?: unknown }): Required<CallQualitySettings> {
  return {
    quality: callQualityOptions.some(option => option.value === value.quality) ? value.quality as CallQuality : 'auto',
    customBitrateKbps: typeof value.customBitrateKbps === 'number' && Number.isFinite(value.customBitrateKbps)
      ? Math.min(8000, Math.max(100, Math.round(value.customBitrateKbps))) : 2000,
  }
}
export function callEncoding(settings: CallQualitySettings) {
  const { quality, customBitrateKbps } = normalizeCallQuality(settings)
  return {
    maxBitrate: quality === 'custom' ? customBitrateKbps * 1000 : { auto: 2_000_000, high: 4_000_000, save: 400_000 }[quality],
    maxFramerate: quality === 'save' ? 20 : 30,
    width: quality === 'high' ? 1920 : quality === 'save' ? 640 : 1280,
    height: quality === 'high' ? 1080 : quality === 'save' ? 360 : 720,
    codec: quality === 'high' ? 'avc1.42e028' : 'avc1.42e01f',
  }
}

/** Preserve camera orientation and aspect ratio; never upscale the captured image. */
export function callVideoFramerate(settings: CallQualitySettings, bitrate = Infinity) {
  return Math.min(callEncoding(settings).maxFramerate, bitrate < 200_000 ? 10 : bitrate < 500_000 ? 15 : 30)
}
export function callVideoSize(settings: CallQualitySettings, capture?: { width?: number; height?: number }, bitrate = Infinity) {
  const quality = callEncoding(settings), width = capture?.width || quality.width, height = capture?.height || quality.height
  const longEdge = Math.min(quality.width, bitrate < 200_000 ? 256 : bitrate < 500_000 ? 480 : bitrate < 1_000_000 ? 960 : quality.width)
  const shortEdge = longEdge * quality.height / quality.width
  const portrait = height > width
  const scale = Math.min(1, (portrait ? shortEdge : longEdge) / width, (portrait ? longEdge : shortEdge) / height)
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) }
}
