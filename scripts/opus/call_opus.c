#include <opus.h>
#include <stdint.h>
static OpusEncoder *encoder;
static OpusDecoder *decoder;
static float pcm[960];
static unsigned char packet[1275];
int call_init(void) {
  int error;
  encoder = opus_encoder_create(48000, 1, OPUS_APPLICATION_VOIP, &error);
  if (!encoder) return error;
  opus_encoder_ctl(encoder, OPUS_SET_BITRATE(32000));
  opus_encoder_ctl(encoder, OPUS_SET_INBAND_FEC(1));
  opus_encoder_ctl(encoder, OPUS_SET_PACKET_LOSS_PERC(10));
  opus_encoder_ctl(encoder, OPUS_SET_DTX(1));
  decoder = opus_decoder_create(48000, 1, &error);
  return decoder ? 0 : error;
}
float *call_pcm(void) { return pcm; }
unsigned char *call_packet(void) { return packet; }
int call_encode(void) { return opus_encode_float(encoder, pcm, 960, packet, 1275); }
int call_decode(int length, int fec) {
  if (length < 0 || length > 1275) return OPUS_BAD_ARG;
  return opus_decode_float(decoder, length ? packet : 0, length, pcm, 960, fec);
}
void call_destroy(void) { if (encoder) opus_encoder_destroy(encoder); if (decoder) opus_decoder_destroy(decoder); encoder = 0; decoder = 0; }
