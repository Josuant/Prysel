import { lineWidth } from '@prysel/morphology'
import type { SemanticEdge } from '@prysel/spatial'
import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../src/Canvas.tsx'
import { parseResultChip, planChips, resultChipId, resultName, resultNames } from '../src/chips.ts'
import { checkConnection, outputName } from '../src/connect.ts'
import { chipSource } from '../src/flow/useChipDrag.ts'

/**
 * `a, b = f()`: cada nombre es una pastilla propia, sale por su puerto (`result:a`) y se lleva a una
 * casilla igual que el resultado de una línea que asigna uno solo.
 */

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: 'transform.call',
  label: id,
  line: 1,
  ...extra,
})

const split = node('split', {
  label: 'X_train, X_test',
  results: ['X_train', 'X_test'],
  control: { kind: 'args', target: 'split', args: [{ name: 'datos', value: 'X' }] },
  inputs: ['arg:datos'],
})

describe('los resultados de una línea que asigna varios', () => {
  it('se ofrecen todos como chips, y solo en la tarjeta esbelta', () => {
    expect(resultNames(split, 'normal')).toEqual(['X_train', 'X_test'])
    expect(resultNames(split, 'compact')).toEqual([])
    expect(resultNames(split, 'expanded')).toEqual([])
  })

  it('con uno solo, es el de siempre', () => {
    const one = node('x', { provides: 'x', control: split.control as CanvasNode['control'] })
    expect(resultNames(one, 'normal')).toEqual(['x'])
    expect(resultName(one, 'normal')).toBe('x')
    expect(resultName(split, 'normal')).toBeUndefined()
  })

  it('una asignación de destino y valor (`a, b = b, a`) también los ofrece', () => {
    const swap = node('swap', {
      kind: 'opaque.code',
      label: 'a, b',
      results: ['a', 'b'],
      control: { kind: 'assign', destination: 'a, b', value: 'b, a' },
    })
    expect(resultNames(swap, 'normal')).toEqual(['a', 'b'])
  })

  it('cada chip tiene su id, y de él se sabe la línea y el nombre', () => {
    const id = resultChipId('split', 'X_test')
    expect(parseResultChip(id)).toEqual({ node: 'split', name: 'X_test' })
    expect(parseResultChip('split')).toBeNull()
    expect(parseResultChip('iter:i@loop')).toBeNull()
  })

  it('llevarlo sale por su puerto', () => {
    expect(chipSource(resultChipId('split', 'X_test'))).toEqual({
      from: 'split',
      port: 'result:X_test',
    })
  })

  it('la tarjeta mide un chip más por cada nombre', () => {
    const control = split.control as CanvasNode['control']
    expect(lineWidth(control, ['a', 'b'])).toBeGreaterThan(lineWidth(control, ['a']))
    expect(lineWidth(control, 'a')).toBe(lineWidth(control, ['a']))
  })
})

describe('conectar uno de los resultados', () => {
  const target = node('fit', {
    label: 'fit',
    inputs: ['arg:x'],
    scope: ['X_train', 'X_test'],
    control: { kind: 'args', target: 'fit', args: [{ name: 'x', value: '' }] },
    line: 2,
  })
  const nodes = new Map([split, target].map((n) => [n.id, n]))

  it('el puerto dice qué nombre sale', () => {
    expect(outputName(split, 'result:X_test')).toBe('X_test')
    expect(outputName(split, 'result:otro')).toBeUndefined()
    expect(outputName(split)).toBeUndefined()
  })

  it('se conecta con el nombre del puerto elegido', () => {
    expect(
      checkConnection(nodes, { from: 'split', port: 'result:X_test', to: 'fit', slot: 'arg:x' }),
    ).toEqual({ ok: true, name: 'X_test' })
  })

  it('sin puerto no hay nada que conectar: no sabe cuál de los dos', () => {
    expect(checkConnection(nodes, { from: 'split', to: 'fit', slot: 'arg:x' })).toMatchObject({
      ok: false,
    })
  })
})

describe('el cable de un resultado que la casilla ya nombra no se dibuja', () => {
  it('lo dice el nombre del puerto, no el nodo', () => {
    const fit = node('fit', {
      label: 'fit',
      line: 2,
      inputs: ['arg:x'],
      control: { kind: 'args', target: 'fit', args: [{ name: 'x', value: 'X_test' }] },
    })
    const edges: SemanticEdge[] = [
      {
        from: 'split',
        to: 'fit',
        relation: 'dependency',
        fromPort: 'result:X_test',
        toPort: 'arg:x',
      },
    ]
    const plan = planChips([split, fit], edges, { canAdd: false, density: () => 'normal' })
    expect(plan.hidden.size).toBe(1)
    expect(plan.chipSlots['fit']?.['arg:x']?.name).toBe('X_test')
  })

  it('el que la casilla no nombra se queda: sigue haciendo falta el cable', () => {
    const fit = node('fit', {
      label: 'fit',
      line: 2,
      inputs: ['arg:x'],
      control: { kind: 'args', target: 'fit', args: [{ name: 'x', value: 'X_train' }] },
    })
    const edges: SemanticEdge[] = [
      {
        from: 'split',
        to: 'fit',
        relation: 'dependency',
        fromPort: 'result:X_test',
        toPort: 'arg:x',
      },
    ]
    const plan = planChips([split, fit], edges, { canAdd: false, density: () => 'normal' })
    expect(plan.hidden.size).toBe(0)
  })
})
