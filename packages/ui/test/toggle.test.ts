import { describe, expect, it } from 'vitest'
import { afterToggle } from '../src/program.ts'

/**
 * Plegar lo que una orden abrió para enseñar algo: tiene que quedarse plegado. Antes, la vuelta a mano y lo
 * que se dejaba de revelar al plegarse se anulaban, y la etapa volvía a abrirse sola.
 */
describe('plegar y abrir a mano', () => {
  const none = new Set<string>()

  it('lo abierto para enseñar algo se pliega dejando de enseñarlo (no se le da la vuelta)', () => {
    const after = afterToggle('etapa', new Set(['etapa']), none)
    expect(after.revealed.has('etapa')).toBe(false)
    expect(after.flipped.has('etapa')).toBe(false)
  })

  it('lo demás, como siempre: cada pulsación le da la vuelta', () => {
    const once = afterToggle('etapa', none, none)
    expect(once.flipped.has('etapa')).toBe(true)
    const twice = afterToggle('etapa', once.revealed, once.flipped)
    expect(twice.flipped.has('etapa')).toBe(false)
  })
})
