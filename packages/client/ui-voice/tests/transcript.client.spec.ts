/**
 * Transcript assembly: the provider reports each update as everything it has
 * heard, and can revise its own guess downward. These cases pin the two rules
 * that keep a live preview from losing words the speaker already saw.
 */
import { describe, expect, it } from 'vitest'
import { chooseDraft, mergeTranscript } from '../src/client/transcript.ts'

describe('mergeTranscript', () => {
  it('stacks two pieces that share no overlap', () => {
    const spoken = mergeTranscript('', 'please type the full sentence now')
    expect(spoken).toBe('please type the full sentence now')
    expect(mergeTranscript(spoken, 'and send it')).toBe('please type the full sentence now and send it')
  })

  it('keeps the longer transcript when the later guess is a suffix of it', () => {
    expect(mergeTranscript('open the file', 'the file')).toBe('open the file')
    expect(mergeTranscript('open the file', 'open the file')).toBe('open the file')
  })

  it('takes the whole later transcript when it extends the shown one', () => {
    expect(mergeTranscript('open the', 'open the file and fix it')).toBe('open the file and fix it')
  })

  it('keeps the shown transcript when the later guess is its prefix', () => {
    expect(mergeTranscript('open the file', 'open the')).toBe('open the file')
  })

  it('splices a shared suffix and prefix at the longest overlap', () => {
    // "the file" ends the shown text and starts the later one.
    expect(mergeTranscript('please open the file', 'the file and fix it'))
      .toBe('please open the file and fix it')
    // Case-insensitive, because the provider revises its own capitalization.
    expect(mergeTranscript('open the File', 'file and fix it')).toBe('open the File and fix it')
  })

  it('ignores an overlap shorter than four characters', () => {
    expect(mergeTranscript('say hi', 'hi there')).toBe('say hi hi there')
  })

  it('normalizes whitespace on both sides', () => {
    expect(mergeTranscript('  open\n the  ', ' file ')).toBe('open the file')
  })

  it('answers the other side when one input is empty', () => {
    expect(mergeTranscript('', '')).toBe('')
    expect(mergeTranscript('kept', '')).toBe('kept')
    expect(mergeTranscript('', 'fresh')).toBe('fresh')
    expect(mergeTranscript('kept', '   ')).toBe('kept')
  })
})

describe('chooseDraft', () => {
  it('does not let a tiny later guess wipe a longer transcript', () => {
    const spoken = mergeTranscript('', 'please type the full sentence now')
    const stacked = mergeTranscript(spoken, 'and send it')
    expect(chooseDraft(stacked, 'type type')).toBe(stacked)
  })

  it('takes a later draft that extends what is shown', () => {
    const stacked = 'please type the full sentence now and send it'
    expect(chooseDraft(stacked, `${stacked} please`)).toBe(`${stacked} please`)
  })

  it('takes a much shorter draft when it is still a prefix of the shown one', () => {
    // The wipe guard only holds a guess back when it is unrelated to what is on
    // screen; a revision of the same opening words is the provider narrowing its
    // own guess, which the live preview should show.
    expect(chooseDraft('open the file', 'open the')).toBe('open the')
  })

  it('takes a shorter draft that is not much shorter', () => {
    // 0.6 of 10 characters is 6, so a 7-character guess is not a wipe.
    expect(chooseDraft('open the f', 'open th')).toBe('open th')
  })

  it('answers the other side when one input is empty', () => {
    expect(chooseDraft('', 'fresh')).toBe('fresh')
    expect(chooseDraft('kept', '')).toBe('kept')
    expect(chooseDraft('', '')).toBe('')
  })

  it('normalizes whitespace on both sides', () => {
    expect(chooseDraft('  open  the file ', 'open the file')).toBe('open the file')
  })
})
