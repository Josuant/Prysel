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
  controlHeight,
  diamondBand,
  GATEWAY,
  questionSize,
  docHeadroom,
  extraHeight,
  getKind,
  nodeSize,
  noteHeight,
  shapeFor,
  type ControlModel,
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

describe('el rombo de una decisión (diagrama de flujo)', () => {
  it('entra por el vértice de arriba, el «sí» sale por el de abajo y el «no» por el de la derecha', () => {
    const g = buildShape('diamond', 320, 92)
    expect(g.handles.in).toEqual({ x: 160, y: 0 })
    expect(g.handles.out).toEqual({ x: 160, y: 92 })
    expect(g.handles.alt).toEqual({ x: 320, y: 46 })
  })

  it('el rombo tiene su franja: lo que cabe a la altura de su centro', () => {
    const g = buildShape('diamond', 320, 92)
    expect(92 - g.inset.top - g.inset.bottom).toBe(diamondBand(92))
    expect(320 - g.inset.left - g.inset.right).toBeGreaterThan(0)
  })
})

describe('la decisión como diagrama de flujo: la pregunta y, debajo, la bifurcación', () => {
  it('la pregunta cabe en su píldora, con sus campos y los signos a cada lado', () => {
    const cases: ControlModel[] = [
      { kind: 'condition', field: 'n', operator: '>', value: '5', operators: ['>'] },
      {
        kind: 'condition',
        field: 'temperatura_media',
        operator: '>=',
        value: 'umbral_maximo',
        operators: ['>='],
      },
    ]
    for (const model of cases) {
      const { w } = questionSize(model, 'normal', '')
      const fields =
        model.kind === 'condition' ? (model.field.length + model.value.length) * 7.8 + 46 : 0
      expect(w).toBeGreaterThan(fields + 60)
    }
  })

  it('deja sitio debajo para el tramo de espina y el rombo de la bifurcación', () => {
    const normal = questionSize(undefined, 'normal', '¿x > 1?')
    const compact = questionSize(undefined, 'compact', '¿x > 1?')
    expect(normal.h).toBeGreaterThan(GATEWAY.gap + GATEWAY.size)
    expect(compact.h).toBeLessThan(normal.h)
    expect(compact.w).toBeGreaterThan('¿x > 1?'.length * 7)
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
    // compacto: icono + nombre + punto. normal (esbelta): icono, nombre y un editor de una fila; su alto
    // real sale de lo que lleva dentro (`slimHeight`). expandido: + control completo.
    const min: Record<Density, [number, number]> = {
      compact: [120, 24],
      normal: [150, 56],
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

describe('el alto lo decide el contenido', () => {
  const call = (args: string[]) =>
    ({
      kind: 'args',
      target: 'suma',
      args: args.map((name) => ({ name, value: '' })),
    }) as const

  it('un editor de una fila cabe en el tamaño base', () => {
    expect(extraHeight({ kind: 'number', value: 5 }, 'normal')).toBe(0)
    expect(extraHeight({ kind: 'text', value: 'hola' }, 'normal')).toBe(0)
  })

  it('una llamada con dos argumentos conectados necesita más alto que con uno', () => {
    const one = extraHeight(call(['a']), 'normal', ['arg:a'])
    const two = extraHeight(call(['a', 'b']), 'normal', ['arg:a', 'arg:b'])
    expect(two).toBeGreaterThan(one)
    expect(two).toBeGreaterThan(0)
  })

  it('un argumento conectado nunca se esconde, así que cuenta para el alto', () => {
    // Con más argumentos de los que caben en línea, los que no tienen cable se esconden.
    const many = ['a', 'b', 'c', 'd', 'e', 'f']
    const hidden = controlHeight(call(many), 'normal', [])
    const shown = controlHeight(call(many), 'normal', ['arg:f'])
    expect(shown).toBeGreaterThan(hidden)
  })

  it('una llamada con pocos argumentos los enseña todos: cada uno es un puerto al que cablear', () => {
    const few = controlHeight(call(['a', 'b', 'c']), 'normal', [])
    const one = controlHeight(call(['a']), 'normal', [])
    expect(few).toBeGreaterThan(one)
    expect(controlHeight(call(['a', 'b', 'c']), 'normal', ['arg:c'])).toBe(few)
  })

  it('en compacto no hay editor: una píldora no crece', () => {
    expect(extraHeight(call(['a', 'b']), 'compact', ['arg:a', 'arg:b'])).toBe(0)
  })

  it('una condición y una operación caben en una fila en normal, y se apilan en expandido', () => {
    const condition: ControlModel = {
      kind: 'condition',
      field: 'x',
      operator: '<',
      value: '0',
      operators: ['<'],
    }
    const operation: ControlModel = {
      kind: 'expression',
      left: 'a',
      operator: '+',
      right: 'b',
      operators: ['+'],
    }
    const row = controlHeight({ kind: 'number', value: 1 }, 'normal')
    expect(controlHeight(condition, 'normal')).toBe(row)
    expect(controlHeight(operation, 'normal')).toBe(row)
    expect(controlHeight(condition, 'expanded')).toBeGreaterThan(row)
    expect(controlHeight(operation, 'expanded')).toBeGreaterThan(row)
  })

  it('un mensaje largo crece con sus líneas, hasta un tope', () => {
    const message = (text: string): ControlModel => ({ kind: 'text', value: text, multiline: true })
    const short = controlHeight(message('hola'), 'normal')
    const long = controlHeight(message('x'.repeat(80)), 'normal')
    const huge = controlHeight(message('x'.repeat(2000)), 'normal')
    expect(long).toBeGreaterThan(short)
    expect(huge).toBeGreaterThan(long)
    // Tope: un texto enorme no se come el lienzo, se desplaza dentro de su campo.
    expect(controlHeight(message('x'.repeat(4000)), 'normal')).toBe(huge)
  })

  it('sin editor no hay nada que acomodar', () => {
    expect(extraHeight(undefined, 'normal')).toBe(0)
  })
})

describe('los comentarios ocupan sitio propio', () => {
  it('sin comentario, no añaden nada', () => {
    expect(noteHeight(undefined, 'normal')).toBe(0)
    expect(noteHeight('   ', 'normal')).toBe(0)
  })

  it('en compacto no caben: es una píldora', () => {
    expect(noteHeight('un comentario', 'compact')).toBe(0)
  })

  it('crecen con sus líneas, hasta un tope', () => {
    const one = noteHeight('corto', 'normal')
    const two = noteHeight(
      'una frase bastante más larga que no cabe en una sola línea de la tarjeta',
      'normal',
    )
    const many = noteHeight('palabra '.repeat(200), 'normal')
    expect(two).toBeGreaterThan(one)
    expect(noteHeight('palabra '.repeat(400), 'normal')).toBe(many)
  })

  it('en expandido caben más líneas que en normal', () => {
    const long = 'palabra '.repeat(200)
    expect(noteHeight(long, 'expanded')).toBeGreaterThan(noteHeight(long, 'normal'))
  })

  it('el ajuste es por palabras, no por número de caracteres', () => {
    // 34 caracteres por línea: «aaaa… (30)» + «bbbb… (30)» no caben juntas aunque sumen menos de 2 líneas de texto.
    const a = 'a'.repeat(30)
    const b = 'b'.repeat(30)
    expect(noteHeight(`${a} ${b}`, 'normal')).toBeGreaterThan(noteHeight(a, 'normal'))
  })

  it('un párrafo por línea de comentario', () => {
    expect(noteHeight('uno\ndos', 'normal')).toBeGreaterThan(noteHeight('uno', 'normal'))
  })

  it('la documentación de un territorio pide sitio en su cabecera, con tope', () => {
    expect(docHeadroom(undefined)).toBe(0)
    expect(docHeadroom('Suma dos números.')).toBeGreaterThan(0)
    expect(docHeadroom('palabra '.repeat(500))).toBe(docHeadroom('palabra '.repeat(1000)))
  })

  it('el alto del nodo suma el comentario al del editor', () => {
    const control: ControlModel = { kind: 'number', value: 1 }
    expect(extraHeight(control, 'normal', [], 'una nota')).toBeGreaterThan(
      extraHeight(control, 'normal'),
    )
  })
})
