import { describe, expect, it } from 'vitest'
import { archPath, clearBend, crosses, labelSize, labelSpot } from '../src/flow/ArchEdge.tsx'

/**
 * Las flechas de la arquitectura van de borde a borde y no pasan por encima de ningún otro módulo: si hay uno
 * en medio, se comban lo justo para rodearlo.
 */

const box = (x: number, y: number, w = 260, h = 110) => ({ x, y, w, h })

describe('una flecha entre dos módulos', () => {
  it('sale del borde de uno y llega al borde del otro, no a sus centros', () => {
    const from = box(0, 0)
    const to = box(600, 0)
    const { d, end } = archPath(from, to)
    expect(d.startsWith('M264.0 55.0')).toBe(true)
    expect(end.x).toBeLessThan(600)
    expect(end.x).toBeGreaterThan(560)
  })

  it('sin nada en medio va recta', () => {
    expect(clearBend(box(0, 0), box(600, 0), [box(200, 400)])).toBe(0)
  })

  it('con un módulo en medio, se comba hasta rodearlo', () => {
    const from = box(0, 0)
    const to = box(700, 420)
    const middle = box(330, 190, 300, 150)
    expect(crosses(from, to, 0, [middle])).toBe(true)
    const bend = clearBend(from, to, [middle])
    expect(bend).not.toBe(0)
    expect(crosses(from, to, bend, [middle])).toBe(false)
  })

  it('en la forma de centro: de un satélite de arriba a uno de abajo, rodeando el centro y a los demás', () => {
    // Dos arriba, el centro (grande, una tarjeta de bucle) y dos abajo.
    const centre = box(300, 200, 190, 190)
    const topLeft = box(180, 0, 160, 80)
    const topRight = box(430, 0, 160, 80)
    const bottomLeft = box(180, 470, 160, 80)
    const bottomRight = box(430, 470, 160, 80)
    for (const [from, to, others] of [
      [topLeft, bottomRight, [centre, topRight, bottomLeft]],
      [topLeft, bottomLeft, [centre, topRight, bottomRight]],
      [topRight, bottomLeft, [centre, topLeft, bottomRight]],
    ] as const) {
      const bend = clearBend(from, to, others)
      expect(crosses(from, to, bend, others)).toBe(false)
    }
  })

  it('si nada la libra, se queda como se prefería: mejor una flecha que cruza que ninguna', () => {
    const wall = box(-2000, 150, 5000, 100)
    expect(clearBend(box(0, 0), box(0, 400), [wall], 22)).toBe(22)
  })
})

describe('la pastilla de una flecha', () => {
  const size = labelSize('poblacion ×12')
  const boxAt = (from: ReturnType<typeof box>, to: ReturnType<typeof box>, t: number) => {
    const { mid } = archPath(from, to, 0, t)
    return { x: mid.x - size.w / 2, y: mid.y - size.h / 2, ...size }
  }
  const hit = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  it('con sitio de sobra va en la mitad de la flecha', () => {
    const from = box(0, 0)
    const to = box(600, 0)
    expect(labelSpot(from, to, 0, size, [from, to])).toBe(0.5)
  })

  it('en una flecha corta y en diagonal se corre hasta no tapar a ninguno de los dos módulos', () => {
    // Dos módulos casi pegados, uno más abajo y a la derecha: en la mitad, la pastilla (más ancha que la
    // flecha) pisa la esquina de uno.
    const from = box(0, 0, 240, 90)
    const to = box(150, 140, 240, 90)
    expect([from, to].some((module) => hit(boxAt(from, to, 0.5), module))).toBe(false)
    const tight = box(210, 110, 240, 90)
    const spot = labelSpot(from, tight, 0, size, [from, tight])
    const placed = boxAt(from, tight, spot)
    const middle = boxAt(from, tight, 0.5)
    const covered = (label: ReturnType<typeof box>) =>
      [from, tight].reduce((sum, module) => {
        const w = Math.min(label.x + label.w, module.x + module.w) - Math.max(label.x, module.x)
        const h = Math.min(label.y + label.h, module.y + module.h) - Math.max(label.y, module.y)
        return sum + (w > 0 && h > 0 ? w * h : 0)
      }, 0)
    // Nunca peor que en la mitad.
    expect(covered(placed)).toBeLessThanOrEqual(covered(middle))
  })

  it('no se pone encima de otra pastilla que ya está', () => {
    const from = box(0, 0)
    const to = box(600, 0)
    const taken = boxAt(from, to, 0.5)
    const spot = labelSpot(from, to, 0, size, [from, to, taken])
    expect(spot).not.toBe(0.5)
    expect(hit(boxAt(from, to, spot), taken)).toBe(false)
  })
})
