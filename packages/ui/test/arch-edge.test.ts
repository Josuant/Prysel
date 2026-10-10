import { describe, expect, it } from 'vitest'
import { archPath, clearBend, crosses } from '../src/flow/ArchEdge.tsx'

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
