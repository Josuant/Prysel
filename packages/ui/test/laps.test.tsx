import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { territoryHeadroom } from '../src/flow/frame.ts'
import { LapsStrip } from '../src/flow/LapsStrip.tsx'
import {
  LAPS_HEADROOM,
  MAX_CURVES,
  formatLap,
  pickCurves,
  spark,
  type LapsView,
} from '../src/laps.ts'

/**
 * La franja de vueltas de un bucle de entrenamiento: qué curvas se dibujan, cómo se dibujan y cuánto
 * pide la cabecera del territorio para llevarla.
 */

const IDX = [0, 1, 2, 3]

describe('qué curvas se dibujan', () => {
  it('los nombres con al menos dos números, sin la variable del bucle ni los contadores', () => {
    const names = {
      epoca: [0, 1, 2, 3],
      loss: [8, 4, 2, 1],
      texto: ["'a'", "'b'", "'c'", "'d'"],
      uno: [5, null, null, null],
      w: [5, 3, 2, 1.5],
    }
    expect(pickCurves(names, IDX)).toEqual(['loss', 'w'])
    expect(pickCurves(names, IDX, ['w'])).toEqual(['loss'])
  })

  it('lo que suele vigilarse (pérdida, precisión…) va primero', () => {
    const names = { w: [1, 2, 3, 5], grad: [4, 3, 1, 0.2], accuracy: [0.1, 0.4, 0.6, 0.9] }
    expect(pickCurves(names, IDX)).toEqual(['accuracy', 'w', 'grad'])
  })

  it('caben pocas: nunca más de las que la franja admite', () => {
    const names = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e'].map((name, i) => [name, [i + 1, i + 5, i + 2, i]]),
    )
    expect(pickCurves(names, IDX)).toHaveLength(MAX_CURVES)
    expect(pickCurves(names, IDX, [], 2)).toHaveLength(2)
  })
})

describe('una curva en un rectángulo', () => {
  it('une los números vuelta a vuelta, dentro del rectángulo', () => {
    const { path, dot } = spark([0, 10, 5], [0, 1, 2], 3, 100, 20)
    expect(path.startsWith('M')).toBe(true)
    expect(path.split('L')).toHaveLength(3)
    for (const [x, y] of [...path.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const,
    )) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(100)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(20)
    }
    // El máximo queda arriba y el mínimo abajo.
    expect(dot(1)?.y).toBeLessThan(dot(0)?.y ?? 0)
  })

  it('las vueltas se colocan por su número, no por su posición: una muestra de un bucle largo', () => {
    const { dot } = spark([1, 2, 3], [0, 500, 999], 1000, 100, 20)
    expect(dot(1)?.x).toBeCloseTo(50, 0)
    expect(dot(2)?.x).toBeCloseTo(98, 0)
  })

  it('una vuelta sin número no tiene punto, y una curva plana no se rompe', () => {
    const flat = spark([3, 'x', 3], [0, 1, 2], 3, 100, 20)
    expect(flat.dot(1)).toBeNull()
    expect(Number.isFinite(flat.dot(0)?.y ?? Number.NaN)).toBe(true)
  })
})

describe('un valor de una vuelta', () => {
  it('se enseña corto', () => {
    expect(formatLap(7)).toBe('7')
    expect(formatLap(0.456789)).toBe('0.4568')
    expect(formatLap(0.0000123)).toBe('1.23e-5')
    expect(formatLap(null)).toBe('—')
    expect(formatLap('ndarray 3×4 float32')).toBe('ndarray 3×4 f…')
  })
})

describe('la franja de vueltas', () => {
  const laps = (over: Partial<LapsView> = {}): LapsView => ({
    n: 4,
    done: true,
    idx: IDX,
    names: { epoca: [0, 1, 2, 3], loss: [8, 4, 2, 1] },
    position: 2,
    onPosition: () => undefined,
    ...over,
  })
  const html = (view: LapsView, exclude: string[] = ['epoca']) =>
    renderToStaticMarkup(<LapsStrip laps={view} exclude={exclude} label="cada epoca" />)

  it('dice la vuelta que se mira, sobre cuántas dio', () => {
    expect(html(laps())).toContain('vuelta 3/4')
  })

  it('un bucle que sigue corriendo lo marca', () => {
    expect(html(laps({ done: false }))).toContain('vuelta 3/4 …')
  })

  it('lleva un deslizador con todas las vueltas, y un botón para reproducirlas', () => {
    const out = html(laps())
    expect(out).toContain('type="range"')
    expect(out).toContain('max="3"')
    expect(out).toContain('value="2"')
    expect(out).toContain('aria-label="Reproducir las vueltas"')
  })

  it('dibuja la curva de lo que se vigila, con su valor en esa vuelta', () => {
    const out = html(laps())
    expect(out).toContain('loss')
    expect(out).toContain('<path')
    expect(out).toContain('<circle')
    expect(out).toContain('title="loss: 2"')
    // El contador y la variable del bucle no se dibujan.
    expect(out).not.toContain('title="epoca')
  })

  it('sin quien elija la vuelta, se ve pero no se controla', () => {
    const out = html(laps({ onPosition: undefined as never }))
    expect(out).not.toContain('type="range"')
    expect(out).not.toContain('Reproducir')
    expect(out).toContain('vuelta 3/4')
  })

  it('con una sola vuelta no hay nada que recorrer', () => {
    const out = html(laps({ n: 1, idx: [0], names: { loss: [3] }, position: 0 }))
    expect(out).not.toContain('type="range"')
  })
})

describe('la cabecera del territorio', () => {
  const loop = { kind: 'control.loop', contains: ['a'], control: { kind: 'loop' } }

  it('pide sitio para la franja solo cuando el bucle dio vueltas', () => {
    const plain = territoryHeadroom(loop)
    expect(territoryHeadroom({ ...loop, laps: {} })).toBe(plain + LAPS_HEADROOM)
  })

  it('un bucle sin cuerpo no es un territorio: no lleva franja', () => {
    expect(territoryHeadroom({ ...loop, contains: [], laps: {} })).toBe(0)
  })
})
