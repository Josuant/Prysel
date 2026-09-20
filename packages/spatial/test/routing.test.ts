import { describe, expect, it } from 'vitest'
import { routeOrthogonal, type Rect } from '../src/index.ts'

/** ¿Algún tramo del camino atraviesa el interior del obstáculo? */
function crosses(points: { x: number; y: number }[], o: Rect): boolean {
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]
    const b = points[k]
    if (!a || !b) continue
    const x0 = Math.min(a.x, b.x)
    const x1 = Math.max(a.x, b.x)
    const y0 = Math.min(a.y, b.y)
    const y1 = Math.max(a.y, b.y)
    if (x1 > o.x && x0 < o.x + o.w && y1 > o.y && y0 < o.y + o.h) return true
  }
  return false
}

const A = { x: 0, y: 100 }
const B = { x: 600, y: 100 }

describe('enrutado ortogonal', () => {
  it('sin nada en medio, va derecho', () => {
    const route = routeOrthogonal(A, B, [])
    expect(route?.points).toEqual([A, B])
    expect(route?.d).toBe('M0 100L600 100')
  })

  it('todos sus tramos son horizontales o verticales', () => {
    const wall: Rect = { x: 250, y: 40, w: 100, h: 120 }
    const route = routeOrthogonal(A, B, [wall])
    expect(route).not.toBeNull()
    const points = route?.points ?? []
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1]
      const b = points[k]
      expect(a && b && (a.x === b.x || a.y === b.y)).toBe(true)
    }
  })

  it('rodea lo que se interpone en vez de atravesarlo', () => {
    const wall: Rect = { x: 250, y: 40, w: 100, h: 120 }
    const route = routeOrthogonal(A, B, [wall])
    expect(route && crosses(route.points, wall)).toBe(false)
    expect(route && route.points.length).toBeGreaterThan(2)
  })

  it('guarda una distancia al obstáculo: no roza su borde', () => {
    const wall: Rect = { x: 250, y: 90, w: 100, h: 30 }
    const route = routeOrthogonal(A, B, [wall], { margin: 12 })
    const inflated = { x: wall.x - 11, y: wall.y - 11, w: wall.w + 22, h: wall.h + 22 }
    expect(route && crosses(route.points, inflated)).toBe(false)
  })

  it('esquiva varios obstáculos a la vez', () => {
    const walls: Rect[] = [
      { x: 150, y: 60, w: 80, h: 100 },
      { x: 330, y: 20, w: 80, h: 140 },
      { x: 450, y: 80, w: 60, h: 100 },
    ]
    const route = routeOrthogonal(A, B, walls)
    expect(route).not.toBeNull()
    for (const wall of walls) expect(route && crosses(route.points, wall)).toBe(false)
  })

  it('prefiere el camino que menos tuerce', () => {
    const wall: Rect = { x: 250, y: 60, w: 100, h: 80 }
    const route = routeOrthogonal(A, B, [wall])
    // Subir, pasar y bajar: cuatro giros como mucho.
    expect((route?.points.length ?? 99) - 2).toBeLessThanOrEqual(4)
  })

  it('redondea las esquinas', () => {
    const wall: Rect = { x: 250, y: 60, w: 100, h: 80 }
    expect(routeOrthogonal(A, B, [wall])?.d).toContain('Q')
  })

  it('si el destino queda hacia atrás, no lo enruta: es un retorno y tiene su trazado', () => {
    expect(routeOrthogonal(B, A, [])).toBeNull()
  })

  it('si no hay camino, lo dice en vez de inventárselo', () => {
    // El destino está dentro de un recinto cerrado por los cuatro lados.
    const ring: Rect[] = [
      { x: 520, y: 40, w: 20, h: 120 },
      { x: 660, y: 40, w: 20, h: 120 },
      { x: 520, y: 40, w: 160, h: 20 },
      { x: 520, y: 140, w: 160, h: 20 },
    ]
    expect(routeOrthogonal(A, { x: 640, y: 100 }, ring)).toBeNull()
  })

  it('con demasiados obstáculos cerca, renuncia: el coste tiene tope', () => {
    const crowd: Rect[] = Array.from({ length: 80 }, (_, k) => ({
      x: 100 + (k % 10) * 40,
      y: (Math.floor(k / 10) - 4) * 40,
      w: 20,
      h: 20,
    }))
    expect(routeOrthogonal(A, B, crowd)).toBeNull()
  })

  it('el punto medio cae sobre el recorrido', () => {
    const route = routeOrthogonal(A, B, [])
    expect(route?.mid).toEqual({ x: 300, y: 100 })
  })

  it('funciona en vertical', () => {
    const top = { x: 100, y: 0 }
    const bottom = { x: 100, y: 500 }
    const wall: Rect = { x: 60, y: 200, w: 80, h: 100 }
    const route = routeOrthogonal(top, bottom, [wall], { axis: 'vertical' })
    expect(route).not.toBeNull()
    expect(route && crosses(route.points, wall)).toBe(false)
  })
})
