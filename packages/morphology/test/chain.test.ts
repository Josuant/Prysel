import { describe, expect, it } from 'vitest'
import {
  chainStepText,
  controlHeight,
  moveStep,
  parseChainStep,
  slimControlHeight,
  slimWidth,
  type ControlModel,
} from '../src/index.ts'

/**
 * Una cadena de pasos se edita sin saber Python: se escribe un paso como texto, se cambian dos de sitio,
 * y la tarjeta crece con los pasos que lleva.
 */

describe('escribir un paso', () => {
  it('una llamada, con o sin punto', () => {
    expect(parseChainStep('head(3)')).toEqual({ kind: 'call', name: 'head', args: '3' })
    expect(parseChainStep('.reset_index(drop=True)')).toEqual({
      kind: 'call',
      name: 'reset_index',
      args: 'drop=True',
    })
    expect(parseChainStep('  sum()  ')).toEqual({ kind: 'call', name: 'sum', args: '' })
  })

  it('un nombre sin paréntesis es una llamada; con punto, un atributo', () => {
    expect(parseChainStep('sum')).toEqual({ kind: 'call', name: 'sum', args: '' })
    expect(parseChainStep('.T')).toEqual({ kind: 'attr', name: 'T', args: '' })
  })

  it('un índice', () => {
    expect(parseChainStep('["monto"]')).toEqual({ kind: 'index', name: '', args: '"monto"' })
    expect(parseChainStep('[ 1:3 ]')).toEqual({ kind: 'index', name: '', args: '1:3' })
  })

  it('un argumento con paréntesis dentro no confunde el nombre', () => {
    expect(parseChainStep('apply(lambda x: f(x))')).toEqual({
      kind: 'call',
      name: 'apply',
      args: 'lambda x: f(x)',
    })
  })

  it('lo que no es un paso no lo es', () => {
    for (const bad of ['', '   ', '[]', '[x', 'x)', '(1)', 'a b', '3d()', 'a(\nb)', '.f(', 'f(x']) {
      expect(parseChainStep(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('cada paso se escribe como en el código', () => {
    expect(chainStepText({ kind: 'call', name: 'a', args: '1' })).toBe('.a(1)')
    expect(chainStepText({ kind: 'index', name: '', args: '"x"' })).toBe('["x"]')
    expect(chainStepText({ kind: 'attr', name: 'T', args: '' })).toBe('.T')
  })
})

describe('cambiar un paso de sitio', () => {
  it('sube y baja', () => {
    expect(moveStep(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveStep(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
  })

  it('fuera de rango o al mismo sitio, sin cambios (y sin tocar el original)', () => {
    const steps = ['a', 'b']
    expect(moveStep(steps, 0, 0)).toEqual(['a', 'b'])
    expect(moveStep(steps, 0, 5)).toEqual(['a', 'b'])
    expect(moveStep(steps, -1, 1)).toEqual(['a', 'b'])
    expect(moveStep(steps, 0, 1)).not.toBe(steps)
    expect(steps).toEqual(['a', 'b'])
  })
})

describe('lo que mide una cadena', () => {
  const chain = (steps: number, longest = 'sum'): ControlModel => ({
    kind: 'chain',
    receiver: 'df',
    steps: Array.from({ length: steps }, (_, i) => ({
      kind: 'call' as const,
      name: i === 0 ? longest : 'sum',
      args: '',
    })),
  })

  it('crece una fila por paso, en cualquier densidad', () => {
    expect(slimControlHeight(chain(4))).toBeGreaterThan(slimControlHeight(chain(2)))
    expect(controlHeight(chain(4), 'normal')).toBeGreaterThan(controlHeight(chain(2), 'normal'))
    expect(controlHeight(chain(4), 'expanded')).toBeGreaterThan(controlHeight(chain(2), 'expanded'))
    expect(controlHeight(chain(4), 'compact')).toBe(0)
  })

  it('siempre cabe el receptor y dónde añadir un paso', () => {
    expect(slimControlHeight(chain(1))).toBeGreaterThanOrEqual(60)
  })

  it('el ancho crece con lo que dicen los pasos, hasta un tope', () => {
    expect(slimWidth(224, chain(2))).toBeGreaterThanOrEqual(340)
    expect(slimWidth(224, chain(2, 'un_nombre_de_metodo_larguisimo'))).toBeGreaterThan(
      slimWidth(224, chain(2)),
    )
    expect(slimWidth(224, chain(2, 'x'.repeat(200)))).toBe(500)
  })
})
