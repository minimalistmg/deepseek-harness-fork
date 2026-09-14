/**
 * Push-to-talk bindings: how a written chord parses and which key events it
 * matches. The release rule is the part worth pinning — a user who lets go of
 * the modifier before the letter still ends the utterance.
 */
import { describe, expect, it } from 'vitest'
import {
  matchesPushToTalk, parsePushToTalk, releasesPushToTalk, type PushToTalkEvent,
} from '../src/client/ptt.ts'

/**
 * Build one key event.
 * @param key - the event key.
 * @param modifiers - the modifier state to carry.
 * @returns the event.
 */
function key(key: string, modifiers: Partial<Omit<PushToTalkEvent, 'key'>> = {}): PushToTalkEvent {
  return { key, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...modifiers }
}

describe('parsePushToTalk', () => {
  it('parses a modifier chord', () => {
    expect(parsePushToTalk('Alt+V')).toEqual({ key: 'v', alt: true, ctrl: false, shift: false, meta: false })
  })

  it('accepts the alternative modifier names', () => {
    expect(parsePushToTalk('Option+V')).toMatchObject({ alt: true })
    expect(parsePushToTalk('Control+Shift+Space')).toMatchObject({ ctrl: true, shift: true, key: 'space' })
    expect(parsePushToTalk('Cmd+K')).toMatchObject({ meta: true })
    expect(parsePushToTalk('Command+K')).toMatchObject({ meta: true })
    expect(parsePushToTalk('Meta+K')).toMatchObject({ meta: true })
  })

  it('answers no binding for an empty or key-less spec', () => {
    expect(parsePushToTalk('')).toBeUndefined()
    expect(parsePushToTalk('Alt+')).toBeUndefined()
    expect(parsePushToTalk('   ')).toBeUndefined()
  })
})

describe('matchesPushToTalk', () => {
  const binding = parsePushToTalk('Alt+V')!

  it('matches only the exact chord', () => {
    expect(matchesPushToTalk(key('v', { altKey: true }), binding)).toBe(true)
    expect(matchesPushToTalk(key('V', { altKey: true }), binding)).toBe(true)
    expect(matchesPushToTalk(key('v'), binding)).toBe(false)
    expect(matchesPushToTalk(key('b', { altKey: true }), binding)).toBe(false)
    expect(matchesPushToTalk(key('v', { altKey: true, shiftKey: true }), binding)).toBe(false)
  })
})

describe('releasesPushToTalk', () => {
  it('ends on the letter and on the modifier', () => {
    const binding = parsePushToTalk('Alt+V')!
    expect(releasesPushToTalk(key('v', { altKey: true }), binding)).toBe(true)
    expect(releasesPushToTalk(key('Alt'), binding)).toBe(true)
    expect(releasesPushToTalk(key('Option'), binding)).toBe(true)
  })

  it('ends on whichever modifier the binding names', () => {
    expect(releasesPushToTalk(key('Control'), parsePushToTalk('Ctrl+Space')!)).toBe(true)
    expect(releasesPushToTalk(key('Shift'), parsePushToTalk('Shift+Space')!)).toBe(true)
    expect(releasesPushToTalk(key('Meta'), parsePushToTalk('Meta+Space')!)).toBe(true)
    expect(releasesPushToTalk(key('OS'), parsePushToTalk('Cmd+Space')!)).toBe(true)
  })

  it('ignores a release that belongs to another key', () => {
    const binding = parsePushToTalk('Alt+V')!
    expect(releasesPushToTalk(key('b'), binding)).toBe(false)
    expect(releasesPushToTalk(key('Shift'), binding)).toBe(false)
  })
})
