import { tokenNames } from '@prysel/design-tokens'
import { describe, expect, it } from 'vitest'
import {
  DENSITY_BASE,
  ICONS,
  NODE_KINDS,
  SHAPE_IDS,
  buildShape,
  compactShape,
  complexityScale,
  getKind,
  nodeSize,
  shapeFor,
  type Density,
  type Point,
  type Role,
} from '../src/index.ts'

const DENSITIES = Object.keys(DENSITY_BASE) as Density[]

describe('geometría', () => {
  const sizes: [number, number][] = [
    [200, 36],
    [258, 156],
    [300, 248],
    [340, 300],
    [90, 30],
  ]

  it.each(SHAPE_IDS)('%s: trazado válido y puertos dentro del cuerpo', (id) => {
    for (const [w, h] of sizes) {
      const g = buildShape(id, w, h)
      expect(g.d, `${id} ${w}×${h}`).toMatch(/^M[\d\s.,\-ALQHVMZaqhv]+Z$/)
      for (const layer of g.layers) expect(layer.d).not.toMatch(/NaN|Infinity/)
      const handles = [g.handles.in, g.handles.out, g.handles.alt].filter(
        (p): p is Point => p !== undefined,
      )
      for (const p of handles) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeLessThanOrEqual(w)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeLessThanOrEqual(h)
      }
    }
  })

  it.each(SHAPE_IDS)('%s: el desbordamiento declarado cubre sus capas traseras', (id) => {
    const g = buildShape(id, 258, 156)
    for (const layer of g.layers.filter((l) => l.kind === 'back')) {
      const [dx, dy] = [layer.dx ?? 0, layer.dy ?? 0]
      expect(g.overflow.left).toBeGreaterThanOrEqual(Math.max(0, -dx))
      expect(g.overflow.right).toBeGreaterThanOrEqual(Math.max(0, dx))
      expect(g.overflow.top).toBeGreaterThanOrEqual(Math.max(0, -dy))
      expect(g.overflow.bottom).toBeGreaterThanOrEqual(Math.max(0, dy))
    }
  })

  it('las dos salidas de una bifurcación están separadas de verdad', () => {
    const g = buildShape('card-fork', 258, 156)
    expect(g.handles.alt).toBeDefined()
    expect(Math.abs((g.handles.alt?.y ?? 0) - g.handles.out.y)).toBeGreaterThan(40)
  })
})

describe('catálogo de tipos de nodo', () => {
  it('los ids son únicos', () => {
    const ids = NODE_KINDS.map((k) => k.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('cada tipo se distingue en escala de grises: (silueta, trazo, relleno) es único', () => {
    const seen = new Map<string, string>()
    for (const k of NODE_KINDS) {
      const sig = `${k.shape}|${k.stroke}|${k.fill}`
      expect(seen.get(sig), `${k.id} repite la firma de ${seen.get(sig)}`).toBeUndefined()
      seen.set(sig, k.id)
    }
  })

  it('cada tipo tiene un icono propio dentro del set', () => {
    const icons = NODE_KINDS.filter((k) => k.role !== 'container').map((k) => k.icon)
    expect(new Set(icons).size, 'dos tipos comparten icono').toBe(icons.length)
    for (const k of NODE_KINDS) expect(ICONS[k.icon], k.id).toBeTruthy()
  })

  it('toda familia de insignia que se usa existe como token de diseño', () => {
    for (const k of NODE_KINDS) {
      expect(tokenNames.color).toContain(`badge-${k.badge}-bg`)
      expect(tokenNames.color).toContain(`badge-${k.badge}-fg`)
    }
  })

  it('cada tipo explica su forma', () => {
    for (const k of NODE_KINDS) {
      expect(k.why.length, k.id).toBeGreaterThan(20)
      expect(k.python.length, k.id).toBeGreaterThan(0)
    }
  })

  describe('reglas semánticas', () => {
    it('contenedor ⇔ trazo discontinuo y sin relleno (regla del DS)', () => {
      for (const k of NODE_KINDS) {
        expect(k.role === 'container', k.id).toBe(k.stroke === 'dashed')
        expect(k.role === 'container', k.id).toBe(k.fill === 'none')
      }
    })

    it('trazo punteado ⇒ relleno fantasma (lo ajeno o sin resolver es transparente)', () => {
      for (const k of NODE_KINDS.filter((k) => k.stroke === 'dotted')) {
        expect(k.fill, k.id).toBe('ghost')
      }
    })

    it('la elevación es solo para resultados (la sombra es atención, no decoración)', () => {
      for (const k of NODE_KINDS.filter((k) => k.elevation === 'raised')) {
        expect(k.role, k.id).toBe('output')
      }
    })

    it('el relleno "hatch" no es un rasgo de tipo, solo un modificador de generación', () => {
      for (const k of NODE_KINDS) expect(k.fill, k.id).not.toBe('hatch')
    })

    it('un literal no tiene entrada; un retorno o una excepción no tienen salida', () => {
      for (const k of NODE_KINDS.filter((k) => k.role === 'value')) expect(k.ports.in).toBe(false)
      for (const id of ['control.return', 'control.raise'] as const) {
        expect(getKind(id).ports.out).toBe(false)
      }
    })

    it('todo lo que no es un contenedor se puede editar gráficamente', () => {
      for (const k of NODE_KINDS) {
        expect(k.control === 'none', `${k.id} debería ofrecer un control`).toBe(
          k.role === 'container',
        )
      }
    })

    it('la bifurcación tiene dos salidas; el resto, una', () => {
      for (const k of NODE_KINDS) {
        const alt = buildShape(k.shape, 258, 156).handles.alt
        const bifurca = k.id === 'control.condition' || k.id === 'space.if'
        expect(alt !== undefined, k.id).toBe(bifurca)
      }
    })

    it('todos los roles están representados', () => {
      const roles: Role[] = [
        'value',
        'data',
        'transform',
        'control',
        'effect',
        'output',
        'external',
        'abstraction',
        'opaque',
        'container',
      ]
      const used = new Set(NODE_KINDS.map((k) => k.role))
      for (const r of roles) expect(used, r).toContain(r)
    })
  })

  describe('el contenido cabe en cada densidad', () => {
    // compacto: icono + nombre + punto. normal: + insignia, código y pie. expandido: + control.
    const min: Record<Density, [number, number]> = {
      compact: [120, 24],
      normal: [190, 120],
      expanded: [214, 180],
    }
    it.each(NODE_KINDS.map((k) => k.id))('%s', (id) => {
      const kind = getKind(id)
      for (const density of DENSITIES) {
        const { w, h } = nodeSize(kind, density)
        const { inset } = buildShape(shapeFor(kind, density), w, h)
        const [minW, minH] = min[density]
        expect(w - inset.left - inset.right, `${id}/${density} ancho útil`).toBeGreaterThanOrEqual(
          minW,
        )
        expect(h - inset.top - inset.bottom, `${id}/${density} alto útil`).toBeGreaterThanOrEqual(
          minH,
        )
      }
    })
  })
})

describe('tamaño = complejidad', () => {
  it('crece de forma monótona y se satura', () => {
    let prev = 0
    for (const ops of [0, 1, 3, 7, 20, 100, 10_000]) {
      const s = complexityScale('ops', { ops })
      expect(s).toBeGreaterThanOrEqual(prev)
      expect(s).toBeLessThanOrEqual(1.28)
      prev = s
    }
    expect(complexityScale('ops', { ops: 0 })).toBe(1)
    expect(complexityScale('cardinality', { cardinality: 1e9 })).toBe(1.22)
    expect(complexityScale('none', { ops: 999 })).toBe(1)
  })

  it('cada densidad es estrictamente más grande que la anterior, en rejilla de 2px', () => {
    for (const kind of NODE_KINDS) {
      const sizes = DENSITIES.map((d) => nodeSize(kind, d))
      const areas = sizes.map((s) => s.w * s.h)
      expect([...areas], kind.id).toEqual([...areas].sort((a, b) => a - b))
      expect(new Set(areas).size, kind.id).toBe(areas.length)
      for (const s of sizes) {
        expect(s.w % 2).toBe(0)
        expect(s.h % 2).toBe(0)
      }
    }
  })

  it('en compacto todos los nodos tienen la misma altura: son una fila de píldoras', () => {
    const heights = new Set(NODE_KINDS.map((k) => nodeSize(k, 'compact').h))
    expect(heights.size).toBe(1)
  })

  it('en compacto la silueta dice si transforma o si corta el flujo', () => {
    expect(compactShape(getKind('transform.call'))).toBe('pill-chevron')
    expect(compactShape(getKind('control.raise'))).toBe('pill-cut')
    expect(compactShape(getKind('space.for'))).toBe('pill')
    expect(compactShape(getKind('value.str'))).toBe('pill')
  })
})
