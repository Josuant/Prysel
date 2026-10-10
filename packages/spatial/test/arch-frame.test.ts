import { describe, expect, it } from 'vitest'
import {
  fitZoom,
  layoutArchitecture,
  tailSide,
  withTail,
  type Architecture,
  type Size,
} from '../src/index.ts'

/**
 * La arquitectura se coloca **para el lienzo en el que se ve**: donde la forma admite varias colocaciones (el
 * ciclo: más alto o más ancho, con lo de antes a su izquierda o encima, con el resultado al lado o debajo), se
 * queda con la que se ve más grande ahí. Lo que se mide es el zoom al que cabe entera: es lo que decide si el
 * texto de un módulo se lee.
 */

/** Un algoritmo genético como el que se construye de verdad: tres módulos fuera y un anillo de seis. */
const SIZES = new Map<string, Size>([
  ['problema', { w: 240, h: 102 }],
  ['generar', { w: 266, h: 102 }],
  ['arrancar', { w: 212, h: 74 }],
  ['iterar', { w: 224, h: 102 }],
  ['evaluar', { w: 266, h: 90 }],
  ['aptitud', { w: 266, h: 90 }],
  ['reemplazar', { w: 240, h: 86 }],
  ['seleccionar', { w: 232, h: 90 }],
  ['cruzar', { w: 220, h: 86 }],
])
const RING = ['evaluar', 'aptitud', 'reemplazar', 'seleccionar', 'cruzar']
const GENETICO: Architecture = {
  modules: [...SIZES.keys()].map((id) => ({ id, role: 'logica' as const })),
  links: [
    { from: 'generar', to: 'evaluar', kind: 'data', told: true },
    { from: 'iterar', to: 'evaluar', kind: 'data', told: true },
    { from: 'evaluar', to: 'reemplazar', kind: 'data', told: true },
    { from: 'seleccionar', to: 'cruzar', kind: 'data', told: true },
    ...RING.slice(1).map((id, at) => ({
      from: RING[at] ?? '',
      to: id,
      kind: 'next' as const,
      told: true,
    })),
    { from: 'cruzar', to: 'iterar', kind: 'next', told: true },
  ],
  shape: 'ciclo',
  anchor: 'iterar',
  order: RING,
}
const TAIL = { w: 300, h: 70 }

/** El zoom al que cabe entera, con el resultado donde mejor quede. */
const zoomIn = (bounds: Size, frame: Size) =>
  fitZoom(withTail(bounds, TAIL, tailSide(bounds, TAIL, frame)), frame)

const collisions = (positions: ReadonlyMap<string, { x: number; y: number }>) => {
  const boxes = [...positions].map(([id, at]) => ({
    id,
    ...at,
    ...(SIZES.get(id) ?? { w: 0, h: 0 }),
  }))
  return boxes.flatMap((a, i) =>
    boxes
      .slice(i + 1)
      .filter((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
      .map((b) => `${a.id}×${b.id}`),
  )
}

describe('la arquitectura, colocada para su lienzo', () => {
  const classic = layoutArchitecture(GENETICO, SIZES)

  it.each([
    ['un lienzo apaisado', { w: 1000, h: 480 }, 1.12],
    ['uno casi cuadrado (con el código abierto al lado)', { w: 560, h: 480 }, 1.4],
    ['un móvil', { w: 360, h: 560 }, 1.5],
  ])('en %s se ve más grande que con la colocación de siempre', (_name, frame, gain) => {
    const fitted = layoutArchitecture(GENETICO, SIZES, { frame, tail: TAIL })
    expect(collisions(fitted.positions)).toEqual([])
    const before = fitZoom(withTail(classic.bounds, TAIL, 'right'), frame)
    expect(zoomIn(fitted.bounds, frame)).toBeGreaterThanOrEqual(before * gain)
    // El anillo sigue siendo el mismo: la cabeza arriba, el primer paso a su derecha y el último a su izquierda.
    const at = (id: string) => {
      const corner = fitted.positions.get(id) ?? { x: 0, y: 0 }
      const size = SIZES.get(id) ?? { w: 0, h: 0 }
      return { x: corner.x + size.w / 2, y: corner.y + size.h / 2 }
    }
    for (const id of RING) expect(at('iterar').y).toBeLessThan(at(id).y)
    expect(at('evaluar').x).toBeGreaterThan(at('iterar').x)
    expect(at('cruzar').x).toBeLessThan(at('iterar').x)
    // …y sus pasos giran en el sentido del reloj: bajan por la derecha y suben por la izquierda.
    expect(at('aptitud').y).toBeGreaterThan(at('evaluar').y)
    expect(at('cruzar').y).toBeLessThan(at('seleccionar').y)
  })

  it('sin lienzo que mirar, la colocación es la de siempre', () => {
    const again = layoutArchitecture(GENETICO, SIZES)
    expect([...again.positions]).toEqual([...classic.positions])
    // Lo que se prepara antes, a la izquierda del anillo.
    const x = (id: string) => classic.positions.get(id)?.x ?? 0
    for (const id of RING) expect(x('generar')).toBeLessThan(x(id))
  })

  it('el resultado va a la derecha salvo que debajo se vea claramente más grande', () => {
    const wide = { w: 1200, h: 300 }
    expect(tailSide(wide, TAIL, { w: 1600, h: 700 })).toBe('right')
    expect(tailSide(wide, TAIL, { w: 600, h: 700 })).toBe('bottom')
    expect(tailSide(wide, TAIL, undefined)).toBe('right')
    // Debajo no ensancha el conjunto; al lado no lo alarga.
    expect(withTail(wide, TAIL, 'bottom').w).toBe(1200)
    expect(withTail(wide, TAIL, 'right').h).toBe(300)
  })
})
