/**
 * The dictation text pipeline: verbal punctuation, filler removal, spoken
 * identifiers, and the trailing send instruction. Every helper is a pure
 * rewrite over one settled transcript, so each case states the transcript and
 * the draft it must produce.
 */
import { describe, expect, it } from 'vitest'
import {
  applySpokenIdentifiers, applySpokenPunctuation, cleanupDictation, SEND_COMMAND_RE,
  splitWords, stripFillers, takeSendCommand, toAllCaps, toCamelCase, toKebabCase,
  toPascalCase, toSnakeCase,
} from '../src/client/dictation.ts'

describe('splitWords', () => {
  it('splits on whitespace and written separators', () => {
    expect(splitWords('  user_id-name  ')).toEqual(['user', 'id', 'name'])
  })

  it('answers no words for an empty phrase', () => {
    expect(splitWords('   ')).toEqual([])
  })
})

describe('identifier case', () => {
  it('joins words in each named case', () => {
    expect(toCamelCase('User ID')).toBe('userId')
    expect(toSnakeCase('User ID')).toBe('user_id')
    expect(toPascalCase('user id')).toBe('UserId')
    expect(toKebabCase('User ID')).toBe('user-id')
    expect(toAllCaps('user id')).toBe('USER ID')
  })

  it('answers an empty identifier for an empty phrase', () => {
    expect(toCamelCase('  ')).toBe('')
    expect(toSnakeCase('  ')).toBe('')
    expect(toPascalCase('  ')).toBe('')
    expect(toKebabCase('  ')).toBe('')
    expect(toAllCaps('  ')).toBe('')
    // Camel case returns the trimmed phrase when it holds no word at all, so a
    // cue with only punctuation keeps what the speaker said.
    expect(toCamelCase('...')).toBe('...')
  })
})

describe('applySpokenIdentifiers', () => {
  const cues: readonly (readonly [string, string])[] = [
    ['user id in camel case', 'userId'],
    ['in camel case user id', 'userId'],
    ['user id in snake case', 'user_id'],
    ['in snake case user id', 'user_id'],
    ['user id in pascal case', 'UserId'],
    ['in pascal case user id', 'UserId'],
    ['user id in kebab case', 'user-id'],
    ['in kebab case user id', 'user-id'],
    ['user id in all caps', 'USER ID'],
    ['all caps user id', 'USER ID'],
  ]

  it.each(cues)('converts %s', (spoken, written) => {
    expect(applySpokenIdentifiers(spoken)).toBe(written)
  })

  it('leaves a sentence with no cue alone, apart from its spacing', () => {
    expect(applySpokenIdentifiers('open  the file')).toBe('open the file')
  })

  it('converts several cues in one transcript', () => {
    expect(applySpokenIdentifiers('user id in camel case. item id in snake case'))
      .toBe('userId. item_id')
  })
})

describe('applySpokenPunctuation', () => {
  it('writes every dictated mark', () => {
    expect(applySpokenPunctuation('one period two comma three question mark four exclamation mark'))
      .toBe('one. two, three? four!')
    expect(applySpokenPunctuation('stop full stop')).toBe('stop.')
    expect(applySpokenPunctuation('wait exclamation point')).toBe('wait!')
    expect(applySpokenPunctuation('list colon item semicolon next')).toBe('list: item; next')
    expect(applySpokenPunctuation('first new line second')).toBe('first\nsecond')
  })

  it('leaves text without a spoken mark alone', () => {
    expect(applySpokenPunctuation('open the file')).toBe('open the file')
  })
})

describe('stripFillers', () => {
  it('drops spoken fillers and hedges', () => {
    expect(stripFillers('um open uh the like file you know')).toBe('open the file')
    expect(stripFillers('basically it is actually fine')).toBe('it is fine')
    expect(stripFillers('okay so we sort of kind of hmm ship it')).toBe('we ship it')
  })

  it('collapses a stutter repeat', () => {
    expect(stripFillers('the the file to to open')).toBe('the file to open')
  })

  it('tidies the punctuation spacing a removal leaves behind', () => {
    expect(stripFillers('open the file ,then stop .')).toBe('open the file, then stop.')
  })

  it('collapses a run of blank lines', () => {
    expect(stripFillers('one\n\n\n\ntwo')).toBe('one\n\ntwo')
  })

  it('leaves a clean transcript alone', () => {
    expect(stripFillers('open the file')).toBe('open the file')
  })
})

describe('cleanupDictation', () => {
  it('applies punctuation, fillers, and identifiers in that order', () => {
    expect(cleanupDictation('um user id in camel case period')).toBe('userId.')
  })

  it('answers the empty string for a transcript of nothing but fillers', () => {
    expect(cleanupDictation('um uh like')).toBe('')
  })
})

describe('takeSendCommand', () => {
  it('reports the empty transcript as nothing to do', () => {
    expect(takeSendCommand('   ')).toEqual({ text: '', send: false })
  })

  it('takes every spoken send phrase off the end', () => {
    expect(takeSendCommand('open the file send')).toEqual({ text: 'open the file', send: true })
    expect(takeSendCommand('open the file send it')).toEqual({ text: 'open the file', send: true })
    expect(takeSendCommand('open the file send when done')).toEqual({ text: 'open the file', send: true })
    expect(takeSendCommand('open the file send when you are done.')).toEqual({ text: 'open the file', send: true })
    expect(takeSendCommand('open the file send when youre done')).toEqual({ text: 'open the file', send: true })
    expect(takeSendCommand('send it')).toEqual({ text: '', send: true })
  })

  it('leaves a transcript whose send word is not the instruction alone', () => {
    expect(takeSendCommand('send the file to the parser')).toEqual({ text: 'send the file to the parser', send: false })
    expect(takeSendCommand('the sender is wrong')).toEqual({ text: 'the sender is wrong', send: false })
  })

  it('matches only a trailing phrase', () => {
    expect(SEND_COMMAND_RE.test('open the file send')).toBe(true)
    expect(SEND_COMMAND_RE.test('send the file')).toBe(false)
  })
})
