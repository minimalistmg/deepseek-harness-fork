/**
 * Microphone audio to wire bytes: resampling, 16-bit encoding, base64, and the
 * 100 ms framing the provider asks for.
 */
import { describe, expect, it } from 'vitest'
import {
  encodePcm16, resample, rmsLevel, takePcmChunks, toBase64, VOICE_LIVE_CHUNK_FRAMES, VOICE_LIVE_SAMPLE_RATE,
} from '../src/client/pcm.ts'

/** A ramp of `count` samples, so every value is distinguishable. */
function ramp(count: number): Float32Array {
  return Float32Array.from({ length: count }, (_, index) => index / count)
}

describe('rmsLevel', () => {
  it('measures the root mean square of a block', () => {
    expect(rmsLevel(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5)
    expect(rmsLevel(new Float32Array([0.25]))).toBeCloseTo(0.25)
  })

  it('answers zero for silence and for an empty block', () => {
    expect(rmsLevel(new Float32Array(4))).toBe(0)
    expect(rmsLevel(new Float32Array(0))).toBe(0)
  })
})

describe('resample', () => {
  it('answers a copy when the rates already match', () => {
    const input = ramp(4)
    const output = resample(input, VOICE_LIVE_SAMPLE_RATE, VOICE_LIVE_SAMPLE_RATE)
    expect(output).toEqual(input)
    expect(output).not.toBe(input)
  })

  it('answers an empty buffer for empty input at a different rate', () => {
    expect(resample(new Float32Array(0), 48_000, VOICE_LIVE_SAMPLE_RATE)).toHaveLength(0)
  })

  it('halves the sample count when the rate halves', () => {
    const output = resample(Float32Array.from([0, 1, 0, 1, 0, 1, 0, 1]), 32_000, 16_000)
    expect(output).toHaveLength(4)
  })

  it('interpolates between the two samples a point falls between', () => {
    const output = resample(Float32Array.from([0, 1]), 2, 4)
    expect(Array.from(output)).toEqual([0, 0.5, 1, 1])
  })

  it('answers one sample per step for a rate increase on a single sample', () => {
    expect(Array.from(resample(Float32Array.from([1]), 16_000, 48_000))).toEqual([1, 1, 1])
  })

  it('holds the last sample when the interpolation reaches past the input', () => {
    const output = resample(Float32Array.from([0, 1]), 4, 2)
    expect(output).toHaveLength(1)
    expect(output[0]).toBe(0)
  })
})

describe('encodePcm16', () => {
  it('writes little-endian signed 16-bit samples', () => {
    // The scaling constant is the largest positive sample, so -1 lands on
    // -32767 rather than on the asymmetric -32768.
    const bytes = encodePcm16(Float32Array.from([0, 1, -1]))
    expect(Array.from(bytes)).toEqual([0x00, 0x00, 0xff, 0x7f, 0x01, 0x80])
  })

  it('rounds to the nearest representable sample', () => {
    const bytes = encodePcm16(Float32Array.from([0.5, -0.5]))
    expect(Array.from(bytes)).toEqual([0x00, 0x40, 0x01, 0xc0])
  })

  it('clamps a sample that leaves the representable range', () => {
    const bytes = encodePcm16(Float32Array.from([2, -2]))
    expect(Array.from(bytes)).toEqual([0xff, 0x7f, 0x00, 0x80])
  })
})

describe('toBase64', () => {
  it('encodes the standard alphabet without line breaks', () => {
    expect(toBase64(Uint8Array.from([0, 0]))).toBe('AAA=')
    expect(toBase64(Uint8Array.from([0xff, 0xff, 0xff]))).toBe('////')
    expect(toBase64(new Uint8Array(0))).toBe('')
  })
})

describe('takePcmChunks', () => {
  it('packs 100 ms frames at 16 kHz and keeps the leftover', () => {
    const packed = takePcmChunks(new Float32Array(0), new Float32Array(2500))
    expect(packed.chunks).toHaveLength(1)
    expect(packed.chunks[0]).toHaveLength(VOICE_LIVE_CHUNK_FRAMES)
    expect(packed.rest).toHaveLength(900)

    const more = takePcmChunks(packed.rest, new Float32Array(800))
    expect(more.chunks).toHaveLength(1)
    expect(more.chunks[0]).toHaveLength(VOICE_LIVE_CHUNK_FRAMES)
    expect(more.rest).toHaveLength(100)
  })

  it('answers no chunk for audio shorter than one frame', () => {
    const packed = takePcmChunks(new Float32Array(0), new Float32Array(10))
    expect(packed.chunks).toHaveLength(0)
    expect(packed.rest).toHaveLength(10)
  })

  it('copies each chunk so the leftover buffer is not retained', () => {
    const packed = takePcmChunks(new Float32Array(0), new Float32Array(3000), 1000)
    expect(packed.chunks).toHaveLength(3)
    for (const chunk of packed.chunks) expect(chunk.buffer.byteLength).toBe(4000)
    expect(packed.rest.buffer.byteLength).toBe(0)
  })

  it('carries sample values across the chunk boundary in order', () => {
    const input = Float32Array.from({ length: 8 }, (_, index) => index)
    const packed = takePcmChunks(Float32Array.from([-2, -1]), input, 4)
    expect(Array.from(packed.chunks[0]!)).toEqual([-2, -1, 0, 1])
    expect(Array.from(packed.chunks[1]!)).toEqual([2, 3, 4, 5])
    expect(Array.from(packed.rest)).toEqual([6, 7])
  })
})
