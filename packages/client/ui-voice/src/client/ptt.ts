/**
 * Push-to-talk key binding for the dictation seat.
 *
 * The binding is written the way a user names it, `Alt+V`, and is matched
 * against a key event with the modifiers that must be down and the ones that
 * must not. A spec naming no key disables the gesture, which is what an empty
 * preference means.
 * @module @deepseek-ai/dsh-client-ui-voice/client/ptt
 */

/** The key event fields a binding is matched against. */
export interface PushToTalkEvent {
  /** `KeyboardEvent.key`, compared without case. */
  readonly key: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
}

/** One parsed push-to-talk binding. */
export interface PushToTalkBinding {
  /** The named key, lower-cased. */
  readonly key: string
  readonly alt: boolean
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
}

/** Modifier names, which are never a chord's key. */
const MODIFIER_NAMES = new Set([
  'alt', 'option', 'ctrl', 'control', 'shift', 'meta', 'cmd', 'command',
])

/**
 * Parse one binding spec such as `Alt+V` or `Ctrl+Shift+Space`.
 * @param spec - the configured binding.
 * @returns the parsed binding, or `undefined` for an empty or key-less spec.
 */
export function parsePushToTalk(spec: string): PushToTalkBinding | undefined {
  const parts = spec.split('+').map(part => part.trim()).filter(Boolean)
  const key = parts.pop()
  if (key === undefined || MODIFIER_NAMES.has(key.toLowerCase())) return undefined
  const modifiers = new Set(parts.map(part => part.toLowerCase()))
  return {
    key: key.toLowerCase(),
    alt: modifiers.has('alt') || modifiers.has('option'),
    ctrl: modifiers.has('ctrl') || modifiers.has('control'),
    shift: modifiers.has('shift'),
    meta: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command'),
  }
}

/**
 * Whether one key event is the push-to-talk key going down.
 * @param event - the key event to test.
 * @param binding - the parsed binding.
 * @returns whether the event is this binding.
 */
export function matchesPushToTalk(event: PushToTalkEvent, binding: PushToTalkBinding): boolean {
  return event.key.toLowerCase() === binding.key
    && event.altKey === binding.alt
    && event.ctrlKey === binding.ctrl
    && event.shiftKey === binding.shift
    && event.metaKey === binding.meta
}

/**
 * Whether a key-up belongs to the same physical gesture as the key-down that
 * started an utterance. A released modifier arrives as its own event, so
 * releasing `Alt` first must still end an `Alt+V` utterance.
 * @param event - the key event to test.
 * @param binding - the parsed binding.
 * @returns whether this release ends the binding's utterance.
 */
export function releasesPushToTalk(event: PushToTalkEvent, binding: PushToTalkBinding): boolean {
  if (matchesPushToTalk(event, binding)) return true
  const key = event.key.toLowerCase()
  if (binding.alt && (key === 'alt' || key === 'option')) return true
  if (binding.ctrl && key === 'control') return true
  if (binding.shift && key === 'shift') return true
  if (binding.meta && (key === 'meta' || key === 'os')) return true
  return false
}
