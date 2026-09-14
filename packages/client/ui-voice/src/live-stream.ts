/**
 * Host side of the live dictation rules: the sequence numbers and the cap that
 * bound one utterance's incoming audio.
 *
 * The provider's messages carry base64 PCM, so the chunks stay encoded here:
 * decoding and re-encoding would allocate twice for no change in what the link
 * transmits. The sequence rule is what makes a transport that loses or reorders
 * a chunk visible instead of silent — an out-of-order chunk is refused rather
 * than decoded as a gap in the speaker's sentence.
 * @module @deepseek-ai/dsh-client-ui-voice/live-stream
 */

import type { VoiceLiveInputFrame } from './live-protocol.ts'

/** How one ingested chunk settled. */
export type VoiceLiveChunkOutcome =
  /** The chunk continued the utterance. */
  | 'accepted'
  /** The chunk's sequence number is not the next one, so the utterance has a gap. */
  | 'gap'
  /** The chunk would carry the utterance past its cap. */
  | 'overflow'

/** One utterance's audio in arrival order, with the cap that bounds it. */
export class AudioStream {
  private nextSequence = 0
  private carried = 0

  /**
   * @param maxAudioBytes - cap on decoded audio one utterance may carry.
   */
  constructor(private readonly maxAudioBytes: number) {}

  /** The next chunk index this stream accepts. */
  get expectedSequence(): number {
    return this.nextSequence
  }

  /**
   * Ingest one audio frame.
   * @param frame - the frame read from the request body.
   * @returns how the frame settled.
   */
  push(frame: VoiceLiveInputFrame): VoiceLiveChunkOutcome {
    if (frame.sequence !== this.nextSequence) return 'gap'
    this.nextSequence += 1
    // Base64 carries three bytes per four characters, so this is the decoded
    // size without allocating the decoded buffer.
    const bytes = (frame.data.length * 3) / 4
    if (this.carried + bytes > this.maxAudioBytes) return 'overflow'
    this.carried += bytes
    return 'accepted'
  }
}
