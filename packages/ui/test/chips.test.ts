import type { SemanticEdge } from '@prysel/spatial'
import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../src/Canvas.tsx'
import {
  MODULE,
  TRAY,
  chipSize,
  chipValue,
  dockChips,
  isChipKind,
  packChips,
  planChips,
  trayLayout,
} from '../src/chips.ts'

/**
 * Cuándo algo es un chip (una inicialización del contexto, que se porta) y cuándo un nodo con cable
 * (lo que se calcula o llega de fuera, y tiene procedencia).
 */

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: 'transform.call',
  label: id,
  ...extra,
})
const value = (id: string, line: number, extra: Partial<CanvasNode> = {}): CanvasNode =>
  node(id, {
    kind: 'value.number',
    valueType: 'number',
    provides: id,
    line,
    control: { kind: 'number', value: 1 },
    ...extra,
  })
const edge = (from: string, to: string, toPort: string): SemanticEdge => ({
  from,
  to,
  toPort,
  relation: 'dependency',
})

describe('qué es un chip', () => {
  it('un valor escalar con nombre', () => {
    for (const kind of ['value.number', 'value.str', 'value.bool', 'value.none'] as const) {
      expect(isChipKind({ kind, provides: 'x' })).toBe(true)
    }
  })

  it('lo que se calcula no lo es: una llamada, una operación, una lista', () => {
    for (const kind of [
      'transform.call',
      'transform.operation',
      'data.list',
      'data.dict',
    ] as const) {
      expect(isChipKind({ kind, provides: 'x' })).toBe(false)
    }
  })

  it('sin nombre no hay nada que portar', () => {
    expect(isChipKind({ kind: 'value.number' })).toBe(false)
  })
})

describe('a qué contexto se acopla', () => {
  it('los valores del principio del programa son de la cajita del programa', () => {
    const nodes = [value('a', 1), value('b', 2), node('c', { line: 3 })]
    expect([...dockChips(nodes)]).toEqual([
      ['a', MODULE],
      ['b', MODULE],
    ])
  })

  it('en cuanto algo actúa, lo que venga después ya es parte del flujo', () => {
    const nodes = [value('a', 1), node('accion', { line: 2 }), value('b', 3)]
    expect(dockChips(nodes).has('a')).toBe(true)
    expect(dockChips(nodes).has('b')).toBe(false)
  })

  it('los import, las listas y las funciones no cortan la preparación', () => {
    const nodes = [
      node('os', { kind: 'external.import', line: 1 }),
      value('a', 2),
      node('lista', { kind: 'data.list', line: 3, provides: 'lista' }),
      node('f', { kind: 'abstraction.collapsed', line: 4 }),
      value('b', 5),
      node('accion', { line: 6 }),
    ]
    expect([...dockChips(nodes).keys()]).toEqual(['a', 'b'])
  })

  it('en una función, sus inicializaciones son de su cajita', () => {
    const nodes = [
      node('f', { kind: 'abstraction.collapsed', line: 1, contains: ['p', 'op'] }),
      value('p', 2, { owner: 'f' }),
      node('op', { line: 3, owner: 'f' }),
    ]
    expect(dockChips(nodes).get('p')).toBe('f')
  })

  it('un valor de una rama de una decisión no es una inicialización: se queda en el flujo', () => {
    const nodes = [
      node('f', { kind: 'abstraction.collapsed', line: 1, contains: ['si', 'p', 'op'] }),
      node('si', { kind: 'control.condition', line: 2, owner: 'f' }),
      value('p', 3, { owner: 'si' }),
      node('op', { line: 4, owner: 'f' }),
    ]
    expect(dockChips(nodes).has('p')).toBe(false)
  })

  it('un contexto que solo tuviera chips no es un territorio: sus chips se quedan como nodos', () => {
    const nodes = [
      node('f', { kind: 'abstraction.collapsed', line: 1, contains: ['p'] }),
      value('p', 2, { owner: 'f' }),
    ]
    expect(dockChips(nodes).size).toBe(0)
  })

  it('cada bucle tiene la suya', () => {
    const nodes = [
      node('bucle', { kind: 'control.loop', line: 1, contains: ['x', 'op'] }),
      value('x', 2, { owner: 'bucle' }),
      node('op', { line: 3, owner: 'bucle' }),
    ]
    expect(dockChips(nodes).get('x')).toBe('bucle')
  })
})

describe('el reparto en chips', () => {
  const NODES = [
    value('a', 1),
    value('b', 2),
    node('op', { line: 3, inputs: ['left'] }),
    node('otro', { line: 4, inputs: ['left', 'right'] }),
  ]

  it('los chips acoplados no se colocan en el plano, y sus cables tampoco se dibujan', () => {
    const plan = planChips(NODES, [edge('a', 'op', 'left'), edge('op', 'otro', 'left')], {
      canAdd: true,
    })
    expect(plan.flowNodes.map((n) => n.id)).toEqual(['op', 'otro'])
    expect(plan.flowEdges.map((e) => e.from)).toEqual(['op'])
  })

  it('la casilla que recibe un chip lo lleva dentro, con su nombre y su clase', () => {
    const plan = planChips(NODES, [edge('a', 'op', 'left')], { canAdd: true })
    expect(plan.chipSlots['op']?.['left']).toEqual({ name: 'a', type: 'number' })
  })

  it('una casilla que solo recibe chips no necesita puerto; una que recibe también un cable, sí', () => {
    const only = planChips(NODES, [edge('a', 'op', 'left')], { canAdd: true })
    expect(only.chipOnly['op']).toEqual(['left'])
    const mixed = planChips(NODES, [edge('a', 'otro', 'left'), edge('op', 'otro', 'left')], {
      canAdd: true,
    })
    expect(mixed.chipOnly['otro']).toBeUndefined()
  })

  it('las funciones se ofrecen en la cajita del programa', () => {
    const plan = planChips(NODES, [], {
      canAdd: true,
      palette: [{ id: 'def', name: 'suma', signature: '(a, b)', params: ['a', 'b'] }],
    })
    expect(plan.functions.map((f) => f.name)).toEqual(['suma'])
    expect(plan.trays.get(MODULE)?.chips.map((c) => c.id)).toEqual(['a', 'b', 'fn:def'])
  })

  it('un lienzo de solo lectura sin chips no dibuja cajitas vacías', () => {
    expect(planChips([node('x', { line: 1 })], [], { canAdd: false }).trays.size).toBe(0)
  })

  it('uno editable las ofrece aunque estén vacías: es donde se añade lo primero', () => {
    expect(planChips([node('x', { line: 1 })], [], { canAdd: true }).trays.has(MODULE)).toBe(true)
  })

  it('la cajita del programa no ofrece añadir cuando se ve solo una función', () => {
    const plan = planChips(NODES, [], { canAdd: true, addToModule: false })
    expect(plan.trays.get(MODULE)?.add).toBeUndefined()
  })
})

describe('cómo se pinta un chip', () => {
  it('su valor es lo que dice el código', () => {
    expect(chipValue({ control: { kind: 'number', value: 20 } })).toBe('20')
    expect(chipValue({ control: { kind: 'text', value: 'Ana' } })).toBe('"Ana"')
    expect(chipValue({ control: { kind: 'boolean', value: true } })).toBe('True')
    expect(chipValue({})).toBe('None')
  })

  it('un texto largo se recorta', () => {
    const text = 'un texto larguísimo que no cabe'
    expect(chipValue({ control: { kind: 'text', value: text } }).length).toBeLessThan(text.length)
  })

  it('crece con su nombre y su valor', () => {
    const short = chipSize({ label: 'a', control: { kind: 'number', value: 1 } })
    const long = chipSize({ label: 'nombre_largo', control: { kind: 'text', value: 'Ana Pérez' } })
    expect(long.w).toBeGreaterThan(short.w)
    expect(long.h).toBe(short.h)
  })
})

describe('la cajita', () => {
  const box = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, w: 100, h: 28 }))

  it('los chips saltan de fila al llegar al ancho', () => {
    const packed = packChips(box(6), 260, 6)
    expect(packed.placed.map((p) => p.y)).toEqual([0, 0, 34, 34, 68, 68])
    expect(packed.w).toBe(206)
  })

  it('una fila entera cabe sin saltar', () => {
    expect(packChips(box(3), TRAY.maxW).h).toBe(28)
  })

  it('sin nada que colocar no ocupa nada', () => {
    expect(packChips([], 100)).toEqual({ placed: [], w: 0, h: 0 })
  })

  it('con margen: la cajita mide lo que sus chips y el botón de añadir', () => {
    const tray = trayLayout(box(2), true)
    expect(tray?.add).toBeDefined()
    expect(tray?.w).toBe(100 * 2 + TRAY.gap * 2 + TRAY.addW + TRAY.pad * 2)
  })

  it('vacía enseña un botón con texto, para que se entienda qué es', () => {
    expect(trayLayout([], true)?.add?.label).toBe(true)
    expect(trayLayout(box(1), true)?.add?.label).toBe(false)
  })

  it('sin chips y sin poder añadir, no hay cajita', () => {
    expect(trayLayout([], false)).toBeNull()
  })

  it('cada chip queda dentro de la cajita', () => {
    const tray = trayLayout(box(9), true)
    for (const chip of tray?.chips ?? []) {
      expect(chip.x + 100).toBeLessThanOrEqual(tray?.w ?? 0)
      expect(chip.y + 28).toBeLessThanOrEqual(tray?.h ?? 0)
    }
  })
})
