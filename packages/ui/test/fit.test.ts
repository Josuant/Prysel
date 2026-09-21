import { DEFAULT_MAX_RUN, layout, type SemanticEdge, type SemanticNode } from '@prysel/spatial'
import { describe, expect, it } from 'vitest'
import { LEGIBLE_ZOOM, MIN_RUN, RUN_STEP, runFor } from '../src/fit.ts'

/**
 * El largo de una fila según el ancho del lienzo: un panel estrecho pliega el programa antes, para que se
 * lea a un zoom legible en vez de alejarse hasta que los nodos no se ven.
 */

describe('cuánto mide de largo una fila', () => {
  it('en una pantalla grande, la de siempre', () => {
    expect(runFor(1400)).toBeUndefined()
    expect(runFor(DEFAULT_MAX_RUN)).toBeUndefined()
    expect(runFor(4000)).toBeUndefined()
  })

  it('sin medir todavía, o con un ancho absurdo, también', () => {
    for (const width of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(runFor(width), String(width)).toBeUndefined()
    }
  })

  it('en un panel estrecho, lo que cabe a un zoom legible, sin bajar del mínimo', () => {
    expect(runFor(370)).toBe(MIN_RUN)
    expect(runFor(100)).toBe(MIN_RUN)
    expect(MIN_RUN).toBeGreaterThanOrEqual(640)
  })

  it('crece con el ancho, a saltos', () => {
    const wide = runFor(900) ?? 0
    const wider = runFor(1100) ?? 0
    expect(wide).toBeGreaterThan(MIN_RUN)
    expect(wider).toBeGreaterThan(wide)
    expect(wide % RUN_STEP).toBe(0)
    // Un píxel de más no rehace el diagrama: el mismo salto vale para los anchos cercanos.
    expect(runFor(880)).toBe(runFor(890))
  })

  it('lo que pide la fila, a ese zoom, ocupa el ancho del lienzo', () => {
    for (const width of [800, 1000, 1200]) {
      const run = runFor(width) ?? DEFAULT_MAX_RUN
      expect(run * LEGIBLE_ZOOM).toBeGreaterThanOrEqual(width - RUN_STEP)
    }
  })
})

describe('el diagrama plegado a esa fila', () => {
  const node = (id: string): SemanticNode => ({ id, role: 'transform', size: { w: 240, h: 60 } })
  const edge = (from: string, to: string): SemanticEdge => ({ from, to, relation: 'transform' })
  const program = (n: number) => ({
    nodes: Array.from({ length: n }, (_, i) => node(`n${i}`)),
    edges: Array.from({ length: n - 1 }, (_, i) => edge(`n${i}`, `n${i + 1}`)),
  })

  it('una fila más corta da un diagrama más estrecho y más alto', () => {
    const wide = layout(program(14))
    const narrow = layout(program(14), { maxRun: MIN_RUN })
    expect(narrow.bounds.w).toBeLessThan(wide.bounds.w)
    expect(narrow.bounds.h).toBeGreaterThan(wide.bounds.h)
    expect(narrow.rows).toBeGreaterThan(wide.rows)
  })

  it('a un panel estrecho, el zoom de ajuste al ancho sube a algo legible', () => {
    const panel = 370
    const fitZoom = (bounds: { w: number }) => Math.min(1, (panel - 48) / bounds.w)
    const before = fitZoom(layout(program(14)).bounds)
    const after = fitZoom(layout(program(14), { maxRun: runFor(panel) }).bounds)
    expect(after).toBeGreaterThan(before * 1.5)
    expect(after).toBeGreaterThanOrEqual(0.4)
  })

  it('ningún nodo queda más ancho que la fila mínima: cabe siempre', () => {
    const result = layout(program(6), { maxRun: MIN_RUN })
    for (const placement of result.placements) expect(placement.size.w).toBeLessThan(MIN_RUN)
  })
})
