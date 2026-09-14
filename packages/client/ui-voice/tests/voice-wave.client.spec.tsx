// @vitest-environment jsdom
/**
 * The composer wave dock: it draws nothing before any dictation, draws the
 * utterance envelope while the seat records, and keeps the last envelope on
 * screen once recording stops.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { barHeight, VoiceWave, type VoiceWaveProps } from '../src/client/VoiceWave.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * Render the dock over one meter value.
 * @param listening - whether the seat is recording.
 * @param levels - the level history to draw.
 */
function mount(listening: boolean, levels: readonly number[]) {
  const source = createSnapshotStore({ listening, levels })
  const props = {
    useMeter: bindSnapshotSelector(source),
    t: makeTranslate(en),
  } as unknown as VoiceWaveProps
  render(<VoiceWave {...props} />)
  return source
}

/** The dock's bars, in document order. */
const bars = () => screen.queryAllByRole('img').flatMap(node => [...node.children])

describe('barHeight', () => {
  it('scales a level into the bar range and floors a silent one', () => {
    expect(barHeight(0)).toBeCloseTo(0.08)
    expect(barHeight(0.25)).toBeCloseTo(0.54)
    expect(barHeight(1)).toBe(1)
  })

  it('clamps a level outside the scale', () => {
    expect(barHeight(-1)).toBeCloseTo(0.08)
    expect(barHeight(4)).toBe(1)
  })
})

describe('VoiceWave', () => {
  it('renders nothing before any dictation', () => {
    mount(false, [])
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('draws one bar per captured level', () => {
    mount(true, [0, 0.5, 1])
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(en['wave.label'])
    expect(bars()).toHaveLength(3)
    expect(bars()[0]?.getAttribute('style')).toContain('height: 8%')
    expect(bars()[2]?.getAttribute('style')).toContain('height: 100%')
  })

  it('draws a resting bar while recording before the first level arrives', () => {
    mount(true, [])
    expect(bars()).toHaveLength(1)
    expect(bars()[0]?.getAttribute('style')).toContain('height: 8%')
  })

  it('keeps the last envelope on screen once recording stops', () => {
    mount(false, [0.5])
    expect(bars()).toHaveLength(1)
  })
})
