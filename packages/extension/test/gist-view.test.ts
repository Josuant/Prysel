import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import {
  functionsOf,
  gistSize,
  toCanvasNodes,
  viewOf,
  withSections,
  type GistPiece,
  type GistScene,
} from '@prysel/ui'
import type { Density } from '@prysel/morphology'
import { functionsIn } from '../src/gist/facts.ts'
import type { Gist } from '../src/gist/gist.ts'
import type { Sample } from '../src/gist/sample.ts'
import { valueOf } from '../src/gist/value.ts'
import { sampleScene } from '../webview/src/gisting.ts'

/**
 * La tarjeta «Qué hace»: de la muestra ejecutada a lo que se dibuja (lo que entró → lo que salió), y cómo
 * cambia lo que se ve del programa cuando de una función ya se sabe qué hace.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => Program
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
}, 30_000)

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

const gistOf = (sample: Partial<Sample>, more: Partial<Gist> = {}): Gist => ({
  id: 'def:1:0',
  name: 'f',
  owner: null,
  hash: 'h',
  title: null,
  status: 'ok',
  sample: { inputs: [], steps: 1, lines: 1, invented: false, ...sample },
  ...more,
})
const types = (lane: readonly GistPiece[] | undefined) => (lane ?? []).map((piece) => piece.type)

describe('de la muestra a la escena', () => {
  it('a la izquierda lo que entró, a la derecha lo que salió', () => {
    const scene = sampleScene(
      gistOf(
        {
          inputs: [{ name: 'tablero', value: valueOf('[[0, 1], [1, 0]]') }],
          printed: '.*\n*.\n',
          invented: true,
        },
        { name: 'mostrar_tablero', title: 'Dibuja el tablero' },
      ),
    )
    expect(scene).toMatchObject({
      name: 'mostrar_tablero',
      title: 'Dibuja el tablero',
      example: true,
    })
    expect(scene?.lanes.map(types)).toEqual([['datum'], ['console']])
  })

  it('un método enseña del objeto lo que cambió; si nada cambió y devuelve algo, solo eso', () => {
    const self = {
      cls: 'Cajero',
      before: { estado: valueOf("'Esperando'"), intentos: valueOf(0) },
      after: { estado: valueOf("'Menú'"), intentos: valueOf(0) },
    }
    const changed = sampleScene(gistOf({ returned: valueOf(true), self }, { owner: 'Cajero' }))
    expect(changed?.name).toBe('Cajero.f')
    expect(changed?.lanes.map(types)).toEqual([['note'], ['datum', 'state']])
    const state = changed?.lanes[1]?.[1]
    expect(state?.type === 'state' && state.rows.map((row) => [row.name, row.changed])).toEqual([
      ['estado', true],
      ['intentos', false],
    ])
    const same = sampleScene(
      gistOf({ returned: valueOf(21), self: { ...self, after: self.before } }),
    )
    expect(same?.lanes.map(types)).toEqual([['note'], ['datum']])
  })

  it('lo que deja cambiado, un error, y lo que no deja nada', () => {
    const sorted = sampleScene(
      gistOf({
        inputs: [{ name: 'xs', value: valueOf({ l: [3, 1], n: 2, t: 'list' }) }],
        changed: [
          {
            name: 'xs',
            before: valueOf({ l: [3, 1], n: 2, t: 'list' }),
            after: valueOf({ l: [1, 3], n: 2, t: 'list' }),
          },
        ],
      }),
    )
    expect(sorted?.lanes[1]).toMatchObject([{ type: 'datum', label: 'xs queda', changed: true }])
    expect(sampleScene(gistOf({ error: 'ZeroDivisionError: division by zero' }))?.lanes[1]).toEqual(
      [{ type: 'error', text: 'ZeroDivisionError: division by zero' }],
    )
    expect(sampleScene(gistOf({}))?.lanes.map(types)).toEqual([['note'], ['note']])
  })

  it('sin muestra no hay tarjeta: se ve el diagrama de siempre', () => {
    expect(sampleScene({ ...gistOf({}), status: 'sin-muestra', sample: null })).toBeNull()
  })
})

describe('lo que mide la tarjeta', () => {
  const scene = (lanes: GistPiece[][], more: Partial<GistScene> = {}): GistScene => ({
    name: 'f',
    lanes,
    ...more,
  })

  it('crece con lo que lleva, y una rejilla grande se recorta', () => {
    const small = gistSize(scene([[{ type: 'datum', value: valueOf('[[0, 1], [1, 0]]') }]]))
    const row = `[${Array.from({ length: 12 }, () => '0').join(', ')}]`
    const big = gistSize(
      scene([
        [{ type: 'datum', value: valueOf(`[${Array.from({ length: 9 }, () => row).join(', ')}]`) }],
      ]),
    )
    const huge = gistSize(
      scene([
        [
          {
            type: 'datum',
            value: valueOf(`[${Array.from({ length: 40 }, () => row).join(', ')}]`),
          },
        ],
      ]),
    )
    expect(big.h).toBeGreaterThan(small.h)
    expect(big.w).toBeGreaterThan(small.w)
    // Pasado el tope, más filas no la hacen más alta.
    expect(huge).toEqual(big)
  })

  it('el título y cada carril suman su parte', () => {
    const one = gistSize(scene([[{ type: 'note', text: 'sin entrada' }]]))
    const titled = gistSize(
      scene([[{ type: 'note', text: 'sin entrada' }]], { title: 'Hace algo' }),
    )
    const two = gistSize(
      scene([
        [{ type: 'console', text: 'una línea bastante larga de salida\n' }],
        [{ type: 'console', text: 'otra línea bastante larga de salida\n' }],
      ]),
    )
    expect(titled.h).toBeGreaterThan(one.h)
    expect(two.w).toBeGreaterThan(one.w)
  })
})

describe('el programa, cuando de una función se sabe qué hace', () => {
  const SOURCE = lines(
    'def doble(n):',
    '    r = n * 2',
    '    return r',
    '',
    '',
    'def suelta(n):',
    '    r = n + 1',
    '    return r',
    '',
    '',
    'print(doble(4))',
  )
  const card: GistScene = { name: 'doble', lanes: [[{ type: 'note', text: 'sin entrada' }]] }

  function shown(program: Program, density: Density, gisted: readonly string[]) {
    const nodes = toCanvasNodes(program.nodes).map((node) =>
      gisted.includes(node.label) && node.kind === 'abstraction.collapsed'
        ? { ...node, gist: card }
        : node,
    )
    const all = withSections(nodes, program.edges, program.sections ?? [])
    const view = viewOf(all, program.edges, functionsOf(all, program.edges), {
      focus: null,
      flow: true,
      density,
    })
    return view.view.nodes
  }
  const labels = (nodes: readonly { label: string; kind: string }[]) =>
    nodes.filter((node) => node.kind === 'abstraction.collapsed').map((node) => node.label)

  it('sin tarjeta, una función que el programa usa no se enseña en él (como siempre)', () => {
    expect(labels(shown(parse(SOURCE), 'normal', []))).toEqual(['suelta'])
  })

  it('con tarjeta, se enseña aunque se use, y plegada: se lee qué hace, no cómo', () => {
    const program = parse(SOURCE)
    const nodes = shown(program, 'normal', ['doble', 'suelta'])
    expect(labels(nodes)).toEqual(['doble', 'suelta'])
    // Lo de dentro no se dibuja: está plegada en su tarjeta.
    const doble = nodes.find((node) => node.label === 'doble')
    expect(nodes.some((node) => node.owner === doble?.id)).toBe(false)
    expect(doble?.openable).toBe(true)
  })

  it('en expandido se abre todo, también las que tienen tarjeta', () => {
    const inside = (density: Density) => {
      const nodes = shown(parse(SOURCE), density, ['doble'])
      const doble = nodes.find((node) => node.label === 'doble')
      return nodes.filter((node) => node.owner === doble?.id).length
    }
    expect(inside('normal')).toBe(0)
    expect(inside('expanded')).toBeGreaterThan(0)
  })

  it('la tarjeta solo vale para el texto del que salió', () => {
    const before = functionsIn(parse(SOURCE)).find((fact) => fact.name === 'doble')
    const after = functionsIn(parse(SOURCE.replace('n * 2', 'n * 3'))).find(
      (fact) => fact.name === 'doble',
    )
    expect(before?.id).toBe(after?.id)
    expect(before?.hash).not.toBe(after?.hash)
  })
})

describe('un if con tarjeta se pliega en ella (solo en la vista)', () => {
  const SOURCE = lines(
    'for nota in [9, 5]:',
    '    if nota >= 9:',
    '        print("a")',
    '    elif nota >= 5:',
    '        print("b")',
    '    else:',
    '        print("c")',
    'print("fin")',
  )
  const card: GistScene = {
    name: 'if nota >= 9',
    block: 'condition',
    lanes: [[{ type: 'note', text: 'agujas' }]],
  }

  function shown(density: Density, flipped: readonly string[] = []) {
    const program = parse(SOURCE)
    const nodes = toCanvasNodes(program.nodes).map((node) =>
      node.id === 'if:2:4' ? { ...node, gist: card } : node,
    )
    const all = withSections(nodes, program.edges, program.sections ?? [])
    return viewOf(all, program.edges, functionsOf(all, program.edges), {
      focus: null,
      flow: true,
      density,
      flipped: new Set(flipped),
    }).view
  }

  it('plegado: se ve la tarjeta y no sus ramas, y lo de después sigue enganchado', () => {
    const view = shown('normal')
    const ids = view.nodes.map((node) => node.id)
    expect(ids).toContain('if:2:4')
    expect(ids).not.toContain('elif:4:4')
    expect(ids).not.toContain('expr:5:8')
    expect(ids).toContain('expr:8:0')
    const fold = view.nodes.find((node) => node.id === 'if:2:4')
    expect(fold?.gist).toBe(card)
    expect(fold?.openable).toBe(true)
    // Ninguna arista apunta ya a una rama recogida.
    const gone = new Set(['expr:3:8', 'elif:4:4', 'expr:5:8', 'expr:7:8'])
    expect(view.edges.some((edge) => gone.has(edge.from) || gone.has(edge.to))).toBe(false)
  })

  it('abierto: el rombo de siempre, sin tarjeta, con su chevron para volver a plegarlo', () => {
    const view = shown('normal', ['if:2:4'])
    const ids = view.nodes.map((node) => node.id)
    expect(ids).toContain('elif:4:4')
    const open = view.nodes.find((node) => node.id === 'if:2:4')
    expect(open?.gist).toBeUndefined()
    expect(open?.openable).toBe(true)
  })
})
