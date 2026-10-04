import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import {
  enterSections,
  functionsOf,
  leafSections,
  methodsOf,
  representativeIn,
  resolveSectionAction,
  toCanvasNodes,
  viewOf,
  withSections,
  type SectionInfo,
} from '@prysel/ui'
import type { Density } from '@prysel/morphology'
import { cursorNode } from '../webview/src/player.ts'

/**
 * El algoritmo a la vista: las etapas (comentarios de sección) como tarjetas que se abren en su sitio, las
 * llamadas como subprocesos, los parámetros en su cajita y la función principal desplegada en el programa.
 * Con el ejemplo que lo motivó —el algoritmo genético de `flappy_ga`— se **mide** que el diagrama por
 * defecto enseña el esquema del algoritmo y no una columna de sentencias.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
const examples = path.resolve(__dirname, '../../../examples/lecciones')

let parse: (source: string) => Program
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
}, 30_000)

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

/** Lo que se ve de un programa en una densidad, como lo dibuja el lienzo de la extensión. */
function shown(program: Program, density: Density, focus: string | null = null) {
  const all = withSections(toCanvasNodes(program.nodes), program.edges, program.sections ?? [])
  const functions = functionsOf(all, program.edges)
  return { all, ...viewOf(all, program.edges, functions, { focus, flow: true, density }) }
}

const idAt = (program: Program, line: number) =>
  program.nodes.find((n) => n.line === line)?.id ?? `nada en la línea ${line}`

const TWO_STAGES = lines(
  'def f(n):',
  '    # Preparar: los datos',
  '    a = n + 1',
  '    b = a * 2',
  '',
  '    # Resultado',
  '    if b > 3:',
  '        print(b)',
  '    c = b - 1',
  '',
  'f(2)',
)

describe('las etapas en el lienzo', () => {
  it('cada etapa es un territorio con su número, que envuelve sus sentencias y lo que cuelga de ellas', () => {
    const program = parse(TWO_STAGES)
    const all = withSections(toCanvasNodes(program.nodes), program.edges, program.sections ?? [])
    const stages = all.filter((node) => node.kind === 'space.section')
    expect(stages.map((node) => [node.label, node.section?.ordinal])).toEqual([
      ['Preparar', '1'],
      ['Resultado', '2'],
    ])
    // El `print` de la rama del `if` (una decisión no declara `contains`) también es de la etapa.
    expect(stages[1]?.contains).toEqual(
      expect.arrayContaining([idAt(program, 7), idAt(program, 8), idAt(program, 9)]),
    )
    // La función la envuelve: la gramática la coloca dentro de ella.
    expect(all.find((node) => node.id === idAt(program, 1))?.contains).toEqual(
      expect.arrayContaining(stages.map((node) => node.id)),
    )
    // Lo que usa de antes y lo que deja para después.
    expect(stages[0]?.section?.uses).toEqual(['n'])
    expect(stages[0]?.section?.leaves.map((leaf) => leaf.name)).toEqual(['b'])
    expect(stages[1]?.section?.glyphs).toEqual(['branch', 'output'])
  })

  it('una etapa que solo envuelve un bucle no dibuja un marco dentro de otro: lo encabeza', () => {
    const program = parse(
      lines('# Contar', 'for i in range(3):', '    print(i)', '', '# Terminar', 'print("fin")'),
    )
    const all = withSections(toCanvasNodes(program.nodes), program.edges, program.sections ?? [])
    const loop = all.find((node) => node.kind === 'control.loop')
    expect(loop?.section).toMatchObject({ title: 'Contar', ordinal: '1', merged: true })
    expect(loop?.label).toBe('Contar')
    expect(all.filter((node) => node.kind === 'space.section').map((node) => node.label)).toEqual([
      'Terminar',
    ])
  })

  it('la numeración sigue el esquema: las de dentro de una etapa llevan su número delante', () => {
    const program = parse(readFileSync(path.join(examples, 'flappy_ga.py'), 'utf8'))
    const all = withSections(toCanvasNodes(program.nodes), program.edges, program.sections ?? [])
    const ordinals = new Map(
      all
        .filter((node) => node.section)
        .map((node) => [node.section?.title, node.section?.ordinal]),
    )
    expect(ordinals.get('Evolución')).toBe('2')
    expect(ordinals.get('Probar')).toBe('2.1')
    expect(ordinals.get('Relevo')).toBe('2.4')
    expect(ordinals.get('Resultado')).toBe('3')
  })

  it('normal pliega las etapas hoja; compacto, todo; expandido, nada', () => {
    const program = parse(TWO_STAGES)
    const stages = (density: Density) => {
      const { view, all } = shown(program, density, idAt(program, 1))
      return {
        cards: view.nodes.filter((node) => node.kind === 'space.section').length,
        statements: view.nodes.filter((node) => node.line === 3).length,
        leaves: leafSections(all).size,
      }
    }
    expect(stages('normal')).toEqual({ cards: 2, statements: 0, leaves: 2 })
    expect(stages('expanded')).toEqual({ cards: 2, statements: 1, leaves: 2 })
    expect(stages('compact').statements).toBe(0)
  })

  it('en una etapa abierta, la secuencia llega a su marco, no a su primera sentencia', () => {
    const program = parse(TWO_STAGES)
    const { view, folded } = shown(program, 'expanded', idAt(program, 1))
    const stage = view.nodes.find((node) => node.label === 'Resultado')
    expect(folded.has(stage?.id ?? '')).toBe(false)
    const into = view.edges.filter((e) => e.relation === 'sequence' && e.to === stage?.id)
    expect(into.map((e) => e.from)).toEqual([idAt(program, 4)])
    // Lo que sale, sale de donde sale de verdad: el final de la etapa de antes sigue siendo `b = a * 2`.
    expect(view.edges.some((e) => e.relation === 'sequence' && e.to === idAt(program, 7))).toBe(
      false,
    )
    expect(enterSections(view, folded)).toBe(view)
  })

  it('la entrada de un bucle a su primera sentencia, si esta abre una etapa, llega a la etapa', () => {
    const program = parse(
      lines(
        'for i in range(3):',
        '    # Uno',
        '    a = i',
        '    b = a',
        '',
        '    # Dos',
        '    c = b',
      ),
    )
    const { view } = shown(program, 'expanded')
    const loop = idAt(program, 1)
    const stage = view.nodes.find((node) => node.label === 'Uno')?.id
    // La entrada (de control: no la variable del bucle, que es un dato) no va a `a = i` por encima del
    // título de la etapa: entra en la etapa.
    const entry = (to: string | undefined) =>
      view.edges.some(
        (e) => e.from === loop && e.to === to && e.relation === 'transform' && !e.fromPort,
      )
    expect(entry(idAt(program, 3))).toBe(false)
    expect(entry(stage)).toBe(true)
  })

  it('lo que no se ve lo representa la etapa plegada que lo tiene dentro (el cursor, las notas)', () => {
    const program = parse(TWO_STAGES)
    const { view } = shown(program, 'normal', idAt(program, 1))
    const stage = view.nodes.find((node) => node.label === 'Preparar')
    expect(representativeIn(view.nodes, idAt(program, 3))).toBe(stage?.id)
    expect(representativeIn(view.nodes, stage?.id ?? '')).toBe(stage?.id)
    const visible = new Set(view.nodes.map((node) => node.id))
    const state = { event: { k: 'line', l: 3 }, frames: [] } as unknown as Parameters<
      typeof cursorNode
    >[1]
    expect(cursorNode(program, state, visible, (id) => representativeIn(view.nodes, id))).toBe(
      stage?.id,
    )
  })

  it('lo que se pide «detrás de» o «dentro de» una etapa va a su bloque; a una etapa no se le borra nada', () => {
    const info = { members: ['a', 'b', 'c'] } as unknown as SectionInfo
    const of = (id: string) => (id === 'S' ? info : undefined)
    expect(resolveSectionAction({ type: 'add', template: 'print', after: 'S' }, of)).toEqual({
      type: 'add',
      template: 'print',
      after: 'c',
    })
    expect(resolveSectionAction({ type: 'move', id: 'x', into: 'S' }, of)).toEqual({
      type: 'move',
      id: 'x',
      after: 'c',
    })
    expect(resolveSectionAction({ type: 'move', id: 'x', into: 'S', start: true }, of)).toEqual({
      type: 'move',
      id: 'x',
      before: 'a',
    })
    expect(resolveSectionAction({ type: 'delete', id: 'S' }, of)).toBeNull()
    expect(resolveSectionAction({ type: 'move', id: 'S', after: 'z' }, of)).toBeNull()
    expect(resolveSectionAction({ type: 'delete', id: 'x' }, of)).toEqual({
      type: 'delete',
      id: 'x',
    })
  })
})

describe('el programa desplegado y sus subprocesos', () => {
  it('la función que el programa llama una vez se dibuja en el sitio de la llamada', () => {
    const program = parse(
      lines(
        'def main():',
        '    x = 1',
        '    print(x)',
        '',
        'if __name__ == "__main__":',
        '    main()',
      ),
    )
    const { view } = shown(program, 'normal')
    const main = idAt(program, 1)
    const call = idAt(program, 6)
    const entry = view.nodes.find((node) => node.kind === 'control.entrypoint')
    expect(view.nodes.some((node) => node.id === main)).toBe(true)
    expect(view.nodes.some((node) => node.id === call)).toBe(false)
    expect(view.nodes.find((node) => node.id === main)?.owner).toBe(entry?.id)
    expect(entry?.contains).toEqual(expect.arrayContaining([main, idAt(program, 2)]))
  })

  it('las pastillas nombran los subprocesos, un método con su clase', () => {
    const program = parse(
      lines(
        'class Pajaro:',
        '    def decidir(self):',
        '        return True',
        'def volar():',
        '    p = Pajaro()',
        '    a = p.decidir()',
      ),
    )
    const nodes = toCanvasNodes(program.nodes)
    expect(nodes.find((node) => node.line === 6)?.subprocesses?.map((s) => s.name)).toEqual([
      'Pajaro.decidir',
    ])
    expect(methodsOf(nodes).map((fn) => fn.name)).toEqual(['Pajaro.decidir'])
  })
})

describe('medida: flappy_ga enseña el algoritmo, no una columna de sentencias', () => {
  const load = () => parse(readFileSync(path.join(examples, 'flappy_ga.py'), 'utf8'))
  /** Lo que ocupa el diagrama: los nodos que se colocan (sin los chips de las cajitas). */
  const drawn = (nodes: readonly { id: string; kind: string; provides?: string }[]) =>
    nodes.filter((node) => !/^value\.|^data\.list|^data\.dict/.test(node.kind))

  it('el programa despliega entrenar con sus etapas, y las constantes van a Parámetros', () => {
    const program = load()
    const { view } = shown(program, 'normal')
    const titles = view.nodes.flatMap((node) => (node.section ? [node.section.title] : []))
    expect(titles).toEqual([
      'Población inicial',
      'Evolución',
      'Probar',
      'Juzgar',
      'Criar',
      'Relevo',
      'Resultado',
    ])
    expect(drawn(view.nodes).length).toBeLessThanOrEqual(12)
  })

  it('entrenar y volar, vistas aparte, caben en 8 nodos cada una (antes, 25 y 20)', () => {
    const program = load()
    for (const name of ['entrenar', 'volar']) {
      const fn = program.nodes.find((node) => node.label === name)?.id ?? ''
      const { view } = shown(program, 'normal', fn)
      expect(drawn(view.nodes).length, name).toBeLessThanOrEqual(8)
      // Cada etapa tiene título.
      for (const node of view.nodes.filter((n) => n.section)) {
        expect(node.section?.title.length, name).toBeGreaterThan(2)
      }
    }
  })

  it('volar enseña sus subprocesos: el constructor y los dos métodos del pájaro', () => {
    const program = load()
    const fn = program.nodes.find((node) => node.label === 'volar')?.id ?? ''
    const { view } = shown(program, 'normal', fn)
    const opens = view.nodes.flatMap((node) => node.section?.opens.map((o) => o.name) ?? [])
    expect(opens).toEqual(expect.arrayContaining(['Pajaro', 'Pajaro.decidir', 'Pajaro.mover']))
  })
})
