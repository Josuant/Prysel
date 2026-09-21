import { describe, expect, it } from 'vitest'
import type { SemanticEdge } from '@prysel/spatial'
import type { CanvasNode } from '../src/Canvas.tsx'
import { dragTerritory } from '../src/drag.ts'
import { nodeFrame } from '../src/flow/frame.ts'
import { foldScopes, functionsOf, programView, toCanvasNodes } from '../src/program.ts'

/**
 * El programa de la captura:
 *
 *   numeroA = 5 ; numero2 = float(input(...))
 *   def suma(a, b): return a + b
 *   def _main():
 *       if numero2 < 0: print(...)            ← dentro de _main
 *       else: r = suma(numeroA, numero2) ; print(...)
 */
const node = (
  id: string,
  kind: CanvasNode['kind'],
  extra: Partial<CanvasNode> = {},
): CanvasNode => ({
  id,
  kind,
  label: id,
  ...extra,
})
const edge = (from: string, to: string, extra: Partial<SemanticEdge> = {}): SemanticEdge => ({
  from,
  to,
  relation: 'transform',
  ...extra,
})

const NODES: CanvasNode[] = [
  node('numeroA', 'value.number'),
  node('numero2', 'transform.call'),
  node('suma', 'abstraction.collapsed', {
    contains: ['ret'],
    control: {
      kind: 'signature',
      params: [
        { name: 'a', value: '' },
        { name: 'b', value: '' },
      ],
    },
  }),
  node('ret', 'control.return'),
  node('_main', 'abstraction.collapsed', {
    contains: ['if', 'msg1', 'call', 'msg2'],
    control: { kind: 'signature', params: [] },
  }),
  node('if', 'control.condition'),
  node('msg1', 'effect.io'),
  node('call', 'transform.call', { opens: 'suma', openable: true }),
  node('msg2', 'effect.io'),
]
const EDGES: SemanticEdge[] = [
  edge('suma', 'ret', { toPort: 'left' }), // parámetros: internos
  edge('numero2', 'if', { toPort: 'field' }),
  edge('if', 'msg1', { relation: 'branch', label: 'verdadero' }),
  edge('if', 'call', { relation: 'branch', label: 'falso' }),
  edge('suma', 'call'), // la llamada usa la función: la función se usa
  edge('numeroA', 'call', { toPort: 'arg:a' }),
  edge('numero2', 'call', { toPort: 'arg:b' }),
  edge('call', 'msg2'),
]

const ids = (nodes: CanvasNode[]) => nodes.map((n) => n.id)

describe('qué funciones hay y cuáles se usan', () => {
  const functions = functionsOf(NODES, EDGES)
  const by = (id: string) => functions.find((f) => f.id === id)

  it('una función que algo de fuera usa, está usada; una que nadie llama, no', () => {
    expect(by('suma')?.used).toBe(true)
    expect(by('_main')?.used).toBe(false)
  })

  it('cuenta las llamadas y enseña la firma', () => {
    expect(by('suma')).toMatchObject({ calls: 1, signature: '(a, b)', size: 1 })
    expect(by('_main')).toMatchObject({ calls: 0, signature: '()' })
  })
})

describe('el programa no repite lo que ya dice la llamada', () => {
  const view = programView(NODES, EDGES, null)

  it('la definición de una función usada no se dibuja', () => {
    expect(ids(view.nodes)).not.toContain('suma')
    expect(ids(view.nodes)).not.toContain('ret')
  })

  it('la llamada sí: es la que representa a la función', () => {
    expect(ids(view.nodes)).toContain('call')
  })

  it('una función sin usar se sigue viendo: si no, no estaría en ningún sitio', () => {
    expect(ids(view.nodes)).toContain('_main')
    expect(ids(view.nodes)).toContain('if')
  })

  it('no quedan conexiones colgando de lo que se quitó', () => {
    const visible = new Set(ids(view.nodes))
    expect(view.edges.every((e) => visible.has(e.from) && visible.has(e.to))).toBe(true)
  })
})

describe('una función se ve aparte, en un lienzo limpio', () => {
  it('enseña su contenido, envuelto por ella misma: es donde están sus parámetros', () => {
    const view = programView(NODES, EDGES, 'suma')
    expect(ids(view.nodes)).toEqual(['suma', 'ret'])
  })

  it('sin lo de fuera: ni sus llamadores ni el resto del programa', () => {
    const view = programView(NODES, EDGES, '_main')
    expect(ids(view.nodes).sort()).toEqual(['_main', 'call', 'if', 'msg1', 'msg2'])
    expect(view.edges.every((e) => e.from !== 'numero2')).toBe(true)
  })

  it('conserva las conexiones de dentro', () => {
    const view = programView(NODES, EDGES, '_main')
    expect(view.edges.some((e) => e.from === 'if' && e.to === 'msg1')).toBe(true)
  })
})

describe('compacto pliega las funciones', () => {
  it('cada función pasa a ser un solo nodo con su entrada y su salida', () => {
    const base = programView(NODES, EDGES, null)
    const folded = foldScopes(base.nodes, base.edges, new Set(['_main']))
    expect(ids(folded.nodes).sort()).toEqual(['_main', 'numeroA', 'numero2'].sort())
    // Lo que entraba en su interior entra ahora por su borde.
    expect(folded.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual([
      'numero2>_main',
      'numeroA>_main',
    ])
  })

  it('una arista plegada no apunta a un puerto que ya no existe', () => {
    const base = programView(NODES, EDGES, null)
    const folded = foldScopes(base.nodes, base.edges, new Set(['_main']))
    expect(folded.edges.every((e) => e.toPort === undefined)).toBe(true)
  })
})

describe('de un nodo analizado a uno del lienzo', () => {
  it('con editor no repite el código; sin él, lo enseña', () => {
    const [withControl, without] = toCanvasNodes([
      {
        id: 'a',
        kind: 'value.number',
        label: 'a',
        code: 'a = 5',
        line: 1,
        control: { kind: 'number', value: 5 },
      },
      { id: 'b', kind: 'opaque.code', label: 'b', code: 'match x:', line: 2 },
    ])
    expect(withControl).not.toHaveProperty('code')
    expect(without).toHaveProperty('code', 'match x:')
  })

  it('una llamada a una función del archivo se puede abrir', () => {
    const [call] = toCanvasNodes([
      { id: 'c', kind: 'transform.call', label: 'c', code: 'c = f()', line: 1, calls: 'f' },
    ])
    expect(call).toMatchObject({ opens: 'f', openable: true })
  })
})

describe('mover un territorio mueve lo que envuelve', () => {
  const shown = {
    fn: { x: 100, y: 100 },
    a: { x: 130, y: 160 },
    b: { x: 300, y: 160 },
    fuera: { x: 600, y: 100 },
  }

  it('todo lo de dentro se desplaza lo mismo que el contenedor', () => {
    const next = dragTerritory({}, shown, 'fn', { x: 150, y: 80 }, ['a', 'b'])
    expect(next['fn']).toEqual({ x: 150, y: 80 })
    expect(next['a']).toEqual({ x: 180, y: 140 })
    expect(next['b']).toEqual({ x: 350, y: 140 })
  })

  it('lo de fuera no se toca', () => {
    const next = dragTerritory({}, shown, 'fn', { x: 150, y: 80 }, ['a', 'b'])
    expect(next).not.toHaveProperty('fuera')
  })

  it('un arrastre en varios pasos acumula el desplazamiento, sin contarlo dos veces', () => {
    let moved = dragTerritory({}, shown, 'fn', { x: 110, y: 100 }, ['a'])
    moved = dragTerritory(moved, shown, 'fn', { x: 130, y: 100 }, ['a'])
    expect(moved['a']).toEqual({ x: 160, y: 160 })
  })

  it('un nodo suelto se mueve solo', () => {
    const next = dragTerritory({}, shown, 'fuera', { x: 700, y: 100 }, [])
    expect(Object.keys(next)).toEqual(['fuera'])
  })

  it('respeta lo que el usuario ya había colocado a mano', () => {
    const next = dragTerritory({ a: { x: 0, y: 0 } }, shown, 'fn', { x: 110, y: 100 }, ['a'])
    expect(next['a']).toEqual({ x: 10, y: 0 })
  })
})

describe('la documentación de una función', () => {
  it('llega a la lista de funciones', () => {
    const documented = NODES.map((n) => (n.id === 'suma' ? { ...n, note: 'Suma dos números.' } : n))
    const suma = functionsOf(documented, EDGES).find((f) => f.id === 'suma')
    expect(suma?.doc).toBe('Suma dos números.')
  })

  it('una función sin documentación no inventa una', () => {
    expect(functionsOf(NODES, EDGES).find((f) => f.id === '_main')?.doc).toBeUndefined()
  })

  it('el comentario de un nodo pasa al lienzo', () => {
    const [node] = toCanvasNodes([
      { id: 'a', kind: 'value.number', label: 'a', code: 'a = 5', line: 1, note: 'el tope' },
    ])
    expect(node?.note).toBe('el tope')
  })
})

describe('un nodo llega a React Flow ya medido', () => {
  it('con el tamaño que decidió la gramática, en todas las formas en que React Flow lo lee', () => {
    expect(nodeFrame({ w: 258, h: 156 })).toEqual({
      width: 258,
      height: 156,
      initialWidth: 258,
      initialHeight: 156,
      measured: { width: 258, height: 156 },
    })
  })

  it('sin `measured` React Flow descartaría sus puertos al reconstruir el nodo: es lo que se perdía al mover', () => {
    // La regresión: mover un nodo reconstruye su objeto; sin `measured`, las conexiones desaparecían.
    expect(nodeFrame({ w: 100, h: 40 }).measured).toBeDefined()
  })
})
