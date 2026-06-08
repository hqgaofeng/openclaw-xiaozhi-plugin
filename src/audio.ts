/**
 * Opus ↔ PCM codec wrapper.
 *
 * State-per-session: each XiaozhiSession has 1 decoder (for esp32→bridge
 * audio at 16kHz) and 1 encoder (for bridge→esp32 TTS at 24kHz).
 *
 * Uses the `@discordjs/opus` npm package (most actively maintained
 * Node.js Opus binding). V2 used the Python `opuslib` package in
 * bridge/src/xiaozhi_bridge/protocol/audio.py — same Opus codec,
 * different binding.
 *
 * @see docs/sdk-research-v3.md §1.2 (4 key VAD/audio points).
 */

export class OpusCodec {
  // TODO(M3.2): implement
  //
  // Field plan:
  //   private decoder: @discordjs/opus.OpusDecoder
  //   private encoder: @discordjs/opus.OpusEncoder
  //
  //   constructor(sampleRate: 16000 | 24000, channels: 1, frameDuration: 60)
  //
  //   decode(opusFrame: Buffer): Int16Array
  //     → returns PCM samples (frameSize = sampleRate * frameDuration / 1000)
  //     → uses @discordjs/opus OpusDecoder.decode(opusFrame)
  //
  //   encode(pcm: Int16Array): Buffer
  //     → returns Opus frame
  //     → uses @discordjs/opus OpusEncoder.encode(pcm)
  //
  //   close()
  //     → release decoder/encoder
  //
  // Pitfall (V2 #8.3 lesson):
  //   opuslib defaults to int16 — DO NOT pass float32 (silent output)
}
