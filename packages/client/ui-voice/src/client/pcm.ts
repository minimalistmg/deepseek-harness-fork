/**
 * Microphone audio to the bytes the provider accepts: 16 kHz mono
 * little-endian signed 16-bit PCM, base64-encoded.
 *
 * Capture runs at whatever rate the audio graph actually resolved to, which is
 * not always the rate that was requested, so resampling is an explicit step
 * here rather than an assumption about the device. Resampling is linear
 * interpolation: dictation is speech at a conversational distance, and the
 * provider's own model is the recognizer, so the cost of a higher-order filter
 * buys nothing this link can use.
 * @module @deepseek-ai/dsh-client-ui-voice/client/pcm
 */

/** Sample rate the provider's `audio/pcm;rate=16000` accepts. */
export const VOICE_LIVE_SAMPLE_RATE = 16_000

/** Frames of audio the provider wants in one message: 100 ms at 16 kHz. */
export const VOICE_LIVE_CHUNK_FRAMES = 1600

/** Bytes one sample occupies in the provider's PCM encoding. */
const SAMPLE_BYTES = 2

/** Largest magnitude a signed 16-bit sample carries. */
const INT16_MAX = 32767

/** Largest negative magnitude a signed 16-bit sample carries. */
const INT16_MIN = -32768

/**
 * Resample one block of mono samples.
 * @param input - samples at the source rate.
 * @param fromRate - the rate `input` was captured at.
 * @param toRate - the rate to produce.
 * @returns the resampled samples, or `input` unchanged when the rates match.
 */
export function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array<ArrayBuffer> {
  if (fromRate === toRate) return input.slice()
  if (input.length === 0) return new Float32Array(0)
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate))
  const out = new Float32Array(length)
  const step = fromRate / toRate
  for (let i = 0; i < length; i += 1) {
    const at = i * step
    const base = Math.floor(at)
    const weight = at - base
    /* v8 ignore next 2 -- every index below input.length is in the array. */
    const left = input[base] ?? 0
    const right = input[base + 1] ?? left
    out[i] = left + (right - left) * weight
  }
  return out
}

/**
 * Encode mono samples as little-endian signed 16-bit PCM.
 * @param samples - samples in the range -1..1.
 * @returns the encoded bytes.
 */
export function encodePcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * SAMPLE_BYTES)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i += 1) {
    /* v8 ignore next -- every index below samples.length is in the array. */
    const scaled = Math.round((samples[i] ?? 0) * INT16_MAX)
    view.setInt16(i * SAMPLE_BYTES, Math.min(INT16_MAX, Math.max(INT16_MIN, scaled)), true)
  }
  return bytes
}

/**
 * Measure one block's loudness as its root mean square.
 * @param samples - samples in the range -1..1.
 * @returns the level on the 0–1 scale; 0 for an empty block.
 */
export function rmsLevel(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / (samples.length || 1))
}

/**
 * Base64-encode one byte string.
 * @param bytes - the bytes to encode.
 * @returns the standard-alphabet base64 form, without line breaks.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** One accumulating PCM chunker's output. */
export interface PcmChunks {
  /** Complete provider-sized chunks, in order. */
  readonly chunks: readonly Float32Array[]
  /** Samples left over for the next call. */
  readonly rest: Float32Array
}

/**
 * Append incoming samples and peel off provider-sized frames.
 * @param carry - samples left over from the previous call.
 * @param incoming - the samples just captured.
 * @param frameCount - frames one chunk carries.
 * @returns the complete chunks plus the remaining samples.
 */
export function takePcmChunks(
  carry: Float32Array,
  incoming: Float32Array,
  frameCount: number = VOICE_LIVE_CHUNK_FRAMES,
): PcmChunks {
  const next = new Float32Array(carry.length + incoming.length)
  next.set(carry)
  next.set(incoming, carry.length)
  const chunks: Float32Array[] = []
  let offset = 0
  while (next.length - offset >= frameCount) {
    // Copied rather than viewed: a chunk's encoded bytes are produced after
    // this call returns, and a view would keep the whole utterance's buffer
    // alive for as long as the smallest chunk of it.
    chunks.push(next.slice(offset, offset + frameCount))
    offset += frameCount
  }
  return { chunks, rest: next.slice(offset) }
}
