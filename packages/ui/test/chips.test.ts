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
  mentions,
  iterChipId,
  packChips,
  parseIterChip,
  planChips,
  promoteTarget,
  resultName,
  slotText,
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
  it('un valor literal con nombre', () => {
    for (const kind of ['value.number', 'value.str', 'value.bool'] as const) {
      expect(isChipKind({ kind, provides: 'x', control: { kind: 'number', value: 1 } })).toBe(true)
    }
    // None no tiene editor: es lo único que vale sin él.
    expect(isChipKind({ kind: 'value.none', provides: 'x' })).toBe(true)
  })

  it('una colección literal también: se ve resumida y se edita en un panel', () => {
    expect(
      isChipKind({ kind: 'data.list', provides: 'x', control: { kind: 'list', items: [] } }),
    ).toBe(true)
    expect(
      isChipKind({ kind: 'data.dict', provides: 'x', control: { kind: 'dict', entries: [] } }),
    ).toBe(true)
  })

  it('una lista que el analizador no supo representar (con *resto) no cabe en una píldora', () => {
    expect(isChipKind({ kind: 'data.list', provides: 'x' })).toBe(false)
    expect(isChipKind({ kind: 'value.number', provides: 'x' })).toBe(false)
  })

  it('lo que se calcula no lo es: una llamada, una operación', () => {
    for (const kind of ['transform.call', 'transform.operation'] as const) {
      expect(isChipKind({ kind, provides: 'x', control: { kind: 'number', value: 1 } })).toBe(false)
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

  it('una colección se resume: sus elementos, o sus claves', () => {
    expect(chipValue({ control: { kind: 'list', items: ['1', '2', '3'] } })).toBe('[1, 2, 3]')
    expect(chipValue({ control: { kind: 'dict', entries: [['"a"', '1']] } })).toBe('{"a": 1}')
    const long = chipValue({ control: { kind: 'list', items: Array.from({ length: 30 }, String) } })
    expect(long.length).toBeLessThanOrEqual(20)
    expect(long.endsWith('…')).toBe(true)
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

describe('subir un valor del flujo a las inicializaciones', () => {
  const primero = node('inicio', { line: 1 })

  it('va antes de la primera sentencia de su bloque', () => {
    const x = value('x', 3)
    expect(promoteTarget([primero, node('otra', { line: 2 }), x], x)).toBe('inicio')
  })

  it('en el programa se salta los import', () => {
    const x = value('x', 4)
    const nodes = [node('os', { kind: 'external.import', line: 1 }), primero, x]
    expect(
      promoteTarget([...nodes.slice(0, 1), { ...primero, line: 2 }, { ...x, line: 4 }], x),
    ).toBe('inicio')
  })

  it('un valor de una rama de una decisión no sube: sería incondicional', () => {
    const x = value('x', 3, { owner: 'si' })
    const nodes = [node('si', { kind: 'control.condition', line: 1 }), x]
    expect(promoteTarget(nodes, x)).toBeNull()
  })

  it('uno que ya estaba definido antes no sube: cambiaría lo que ven los usos de entre medias', () => {
    const x = value('x', 3, { scope: ['x'] })
    expect(promoteTarget([primero, x], x)).toBeNull()
  })

  it('el que ya es el primero no tiene adónde subir', () => {
    const x = value('x', 1)
    expect(promoteTarget([x, node('otra', { line: 2 })], x)).toBeNull()
  })

  it('lo que no es un chip no sube', () => {
    expect(promoteTarget([primero, node('op', { line: 2 })], node('op', { line: 2 }))).toBeNull()
  })

  it('dentro de una función sube al principio de su cuerpo', () => {
    const f = node('f', { kind: 'abstraction.collapsed', line: 1, contains: ['s', 'x'] })
    const s = node('s', { line: 2, owner: 'f' })
    const x = value('x', 3, { owner: 'f' })
    expect(promoteTarget([f, s, x], x)).toBe('s')
  })
})

describe('la variable de un bucle es un chip', () => {
  const loop = node('bucle', {
    kind: 'control.loop',
    line: 1,
    params: ['n'],
    provides: 'n',
    contains: ['dentro'],
  })
  const dentro = node('dentro', { line: 2, owner: 'bucle', inputs: ['left'] })
  const cable = (toPort: string, to = 'dentro'): SemanticEdge => ({
    from: 'bucle',
    fromPort: 'param:n',
    to,
    toPort,
    relation: 'dependency',
  })

  it('el id del chip lleva el bucle y el nombre, y se lee de vuelta', () => {
    const id = iterChipId('for:2:0', 'clave')
    expect(parseIterChip(id)).toEqual({ loop: 'for:2:0', name: 'clave' })
    expect(parseIterChip('x')).toBeNull()
  })

  it('va primero en la cajita del bucle, antes de sus inicializaciones', () => {
    const inicial = value('tope', 2, { owner: 'bucle' })
    const plan = planChips([loop, inicial, dentro], [], { canAdd: false })
    const tray = plan.trays.get('bucle')
    expect(tray?.chips.map((chip) => chip.id)).toEqual([iterChipId('bucle', 'n'), 'tope'])
  })

  it('un patrón tiene un chip por nombre', () => {
    const pares = { ...loop, params: ['a', 'b'] }
    const plan = planChips([pares, dentro], [], { canAdd: false })
    expect(plan.iterVars.get('bucle')?.map((v) => v.name)).toEqual(['a', 'b'])
  })

  it('su cable no se dibuja: la casilla enseña el chip', () => {
    const plan = planChips([loop, dentro], [cable('left')], { canAdd: false })
    expect(plan.flowEdges).toEqual([])
    expect(plan.chipSlots['dentro']?.['left']).toEqual({ name: 'n', type: 'any', iter: true })
    expect(plan.chipOnly['dentro']).toEqual(['left'])
  })

  it('un cable del retorno no es una casilla: se queda', () => {
    const plan = planChips([loop, dentro], [cable('return', 'bucle')], { canAdd: false })
    expect(plan.flowEdges).toHaveLength(1)
  })

  it('un bucle sin cuerpo no tiene cajita ni chips', () => {
    const vacio = { ...loop, contains: [] }
    expect(planChips([vacio], [], { canAdd: false }).iterVars.size).toBe(0)
  })

  it('los parámetros de una función también son chips de su cajita', () => {
    const def = node('def', {
      kind: 'abstraction.collapsed',
      line: 1,
      params: ['p'],
      contains: ['dentro'],
    })
    const uso: SemanticEdge = { ...cable('left'), from: 'def', fromPort: 'param:p' }
    const plan = planChips([def, dentro], [uso], { canAdd: false })
    expect(plan.iterVars.get('def')?.map((v) => v.name)).toEqual(['p'])
    expect(plan.flowEdges).toEqual([])
    // Se distingue de la variable de un bucle: el parámetro lo recibe la función, no una vuelta.
    expect(plan.chipSlots['dentro']?.['left']).toEqual({ name: 'p', type: 'any', param: true })
  })

  it('lo que devuelve una función es una pastilla, no un cable, si es una variable', () => {
    const def = node('def', {
      kind: 'abstraction.collapsed',
      line: 1,
      params: ['p'],
      inputs: ['return'],
      contains: ['dentro'],
    })
    const devuelve: SemanticEdge = {
      from: 'def',
      fromPort: 'param:p',
      to: 'def',
      toPort: 'return',
      relation: 'transform',
      via: 'ret',
    }
    const plan = planChips([def, dentro], [devuelve], { canAdd: false, density: () => 'normal' })
    expect(plan.chipSlots['def']?.['return']).toMatchObject({ name: 'p', param: true })
    expect(plan.chipOnly['def']).toEqual(['return'])
    expect(plan.hidden.has(devuelve)).toBe(true)
  })
})

describe('el resultado de una línea es un chip', () => {
  const call = (id: string, provides: string | undefined, args: [string, string][] = []) =>
    node(id, {
      kind: 'transform.call',
      line: 1,
      ...(provides === undefined ? {} : { provides }),
      control: { kind: 'args', target: 'f', args: args.map(([name, value]) => ({ name, value })) },
      inputs: args.map(([name]) => `arg:${name}`),
    })
  const normal = () => 'normal' as const

  it('una llamada o una operación que asigna un nombre lo ofrece', () => {
    expect(resultName(call('x', 'x'), 'normal')).toBe('x')
    expect(
      resultName(
        node('op', {
          kind: 'transform.operation',
          provides: 'op',
          control: { kind: 'expression', left: 'a', operator: '+', right: 'b', operators: ['+'] },
        }),
        'normal',
      ),
    ).toBe('op')
  })

  it('sin nombre asignado (print) o fuera de la tarjeta esbelta, no', () => {
    expect(resultName(call('p', undefined), 'normal')).toBeUndefined()
    expect(resultName(call('x', 'x'), 'compact')).toBeUndefined()
    expect(resultName(call('x', 'x'), 'expanded')).toBeUndefined()
  })

  it('lee lo que hay escrito en una casilla', () => {
    const control = call('c', 'c', [['a', 'x']]).control
    expect(slotText(control, 'arg:a')).toBe('x')
    expect(slotText(control, 'callee')).toBe('f')
    expect(slotText(control, 'arg:z')).toBeUndefined()
    const formula = { kind: 'expression', left: 'p', operator: '+', right: 'q', operators: [] }
    expect(slotText(formula as CanvasNode['control'], 'right')).toBe('q')
  })

  it('su cable no se dibuja cuando la casilla enseña el nombre', () => {
    const x = call('x', 'x')
    const uso = call('uso', 'uso', [['a', 'x']])
    const plan = planChips([x, uso], [edge('x', 'uso', 'arg:a')], {
      canAdd: false,
      density: normal,
    })
    expect(plan.results.has('x')).toBe(true)
    expect(plan.hidden.size).toBe(1)
    expect(plan.chipSlots['uso']?.['arg:a']).toEqual({ name: 'x', type: 'any' })
    expect(plan.chipOnly['uso']).toEqual(['arg:a'])
    // El layout sigue necesitándolo para colocar a cada uno tras el suyo.
    expect(plan.flowEdges).toHaveLength(1)
  })

  it('si la casilla escribe otra cosa (x + 1) sin ser el nombre, no hay pastilla pero el texto ya lo dice', () => {
    const x = call('x', 'x')
    const uso = call('uso', 'uso', [['a', 'x + 1']])
    const plan = planChips([x, uso], [edge('x', 'uso', 'arg:a')], {
      canAdd: false,
      density: normal,
    })
    expect(plan.hidden.size).toBe(1)
    expect(plan.chipSlots['uso']?.['arg:a']?.name).toBe('x')
  })

  it('si la casilla no nombra al origen, el cable se queda: no se sabría de dónde viene', () => {
    const x = call('x', 'x')
    const uso = call('uso', 'uso', [['a', 'otra']])
    const plan = planChips([x, uso], [edge('x', 'uso', 'arg:a')], {
      canAdd: false,
      density: normal,
    })
    expect(plan.hidden.size).toBe(0)
  })

  it('el retorno de una función no es una casilla: su cable se queda', () => {
    const x = call('x', 'x')
    const def = node('def', { kind: 'abstraction.collapsed', inputs: ['return'], contains: ['x'] })
    const plan = planChips([def, x], [edge('x', 'def', 'return')], {
      canAdd: false,
      density: normal,
    })
    expect(plan.hidden.size).toBe(0)
  })

  it('en compacto no hay casillas que enseñen el chip: los cables se dibujan', () => {
    const x = call('x', 'x')
    const uso = call('uso', 'uso', [['a', 'x']])
    const plan = planChips([x, uso], [edge('x', 'uso', 'arg:a')], {
      canAdd: false,
      density: () => 'compact',
    })
    expect(plan.hidden.size).toBe(0)
  })
})

describe('todos los valores son chips: cuándo un cable sobra', () => {
  const normal = () => 'normal' as const

  it('un nombre se menciona entero, no como parte de otro ni como atributo', () => {
    expect(mentions('x', 'x')).toBe(true)
    expect(mentions('x + 1', 'x')).toBe(true)
    expect(mentions('len(xs) + x', 'x')).toBe(true)
    expect(mentions('xs', 'x')).toBe(false)
    expect(mentions('a.x', 'x')).toBe(false)
    expect(mentions('x2', 'x')).toBe(false)
    expect(mentions('a', '')).toBe(false)
  })

  it('cualquier nodo que asigna su título es un chip: comprensión, importación, lambda', () => {
    for (const kind of [
      'transform.comprehension',
      'transform.lambda',
      'external.import',
    ] as const) {
      expect(resultName(node('n', { kind, provides: 'n' }), 'normal')).toBe('n')
    }
    // Si el título no es el nombre que asigna, no es una pastilla.
    expect(
      resultName(
        node('n', { kind: 'external.import', label: 'import x', provides: 'x' }),
        'normal',
      ),
    ).toBeUndefined()
    // Ni una decisión, ni un bucle, ni una función.
    expect(resultName(node('n', { kind: 'control.loop', provides: 'n' }), 'normal')).toBeUndefined()
    expect(
      resultName(node('n', { kind: 'abstraction.collapsed', provides: 'n' }), 'normal'),
    ).toBeUndefined()
  })

  it('un nodo sin casillas (una comprensión) que usa el nombre en su código no necesita cable', () => {
    const xs = node('xs', { kind: 'transform.call', provides: 'xs', line: 1 })
    const ys = node('ys', {
      kind: 'transform.comprehension',
      provides: 'ys',
      code: '[x * 2 for x in xs]',
    })
    const plan = planChips([xs, ys], [{ from: 'xs', to: 'ys', relation: 'transform' }], {
      canAdd: false,
      density: normal,
    })
    expect(plan.hidden.size).toBe(1)
    // Pero el layout sigue sabiendo que ys va después de xs.
    expect(plan.flowEdges).toHaveLength(1)
  })

  it('una conexión de control nunca se oculta', () => {
    const cond = node('if', { kind: 'control.condition', provides: undefined })
    const dentro = node('dentro', { kind: 'transform.call', provides: 'dentro', code: 'if' })
    const plan = planChips([cond, dentro], [{ from: 'if', to: 'dentro', relation: 'branch' }], {
      canAdd: false,
      density: normal,
    })
    expect(plan.hidden.size).toBe(0)
  })
})
