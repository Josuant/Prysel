import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { actionEdits, applyEdits } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

/**
 * Una asignación de varios valores (`X_train, X_test = train_test_split(...)`, `fig, ax = plt.subplots()`):
 * cada nombre sale por su propio puerto y es un chip que se lleva por separado.
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

const at = (program: Program, line: number): ProgramNode => {
  const node = program.nodes.find((n) => n.line === line)
  if (!node) throw new Error(`sin nodo en la línea ${line}`)
  return node
}

const SOURCE = 'X = load()\nX_train, X_test = split(X)\nfit(X_train)\nscore(X_test)\n'

describe('una asignación de varios valores', () => {
  it('deja definidos todos sus nombres, en orden, sin uno principal', () => {
    const node = at(parse(SOURCE), 2)
    expect(node.results).toEqual(['X_train', 'X_test'])
    expect(node.provides).toBeUndefined()
  })

  it('cada consumidor cuelga del puerto de su nombre', () => {
    const program = parse(SOURCE)
    const split = at(program, 2)
    const fromSplit = program.edges.filter((e) => e.from === split.id && e.relation !== 'sequence')
    const ports = new Map(fromSplit.map((e) => [e.to, e.fromPort]))
    expect(ports.get(at(program, 3).id)).toBe('result:X_train')
    expect(ports.get(at(program, 4).id)).toBe('result:X_test')
  })

  it('funciona con una tupla o una lista entre paréntesis', () => {
    expect(at(parse('a, b = 1, 2\n'), 1).results).toEqual(['a', 'b'])
    expect(at(parse('fig, ax, extra = f()\n'), 1).results).toEqual(['fig', 'ax', 'extra'])
  })

  it('no ofrece chips cuando el destino no es una lista de nombres limpia', () => {
    // `*resto` y los paréntesis no caben en una fila de pastillas: el destino se edita como texto.
    expect(at(parse('a, *resto = xs\n'), 1).results).toBeUndefined()
    expect(at(parse('(a, b) = xs\n'), 1).results).toBeUndefined()
    // Pero cada nombre sigue definido: lo que lo usa se enlaza con él.
    const program = parse('a, *resto = xs\nprint(resto)\n')
    expect(
      program.edges.some((e) => e.from === at(program, 1).id && e.to === at(program, 2).id),
    ).toBe(true)
  })

  it('un atributo o un elemento no define nombres', () => {
    const node = at(parse('def f(self, v):\n    self.a, self.b = v, v\n'), 2)
    expect(node.results).toBeUndefined()
  })

  it('renombrar uno cambia ese nombre en todos sus usos y deja los otros', () => {
    const program = parse(SOURCE)
    const split = at(program, 2)
    const text = applyEdits(
      SOURCE,
      actionEdits(program, { type: 'rename', id: split.id, to: 'train', from: 'X_train' }).edits,
    )
    expect(text).toBe('X = load()\ntrain, X_test = split(X)\nfit(train)\nscore(X_test)\n')
  })

  it('conectar uno de ellos a una casilla escribe su nombre', () => {
    const source = 'a, b = f()\nx = 1 + 2\n'
    const program = parse(source)
    const split = at(program, 1)
    const suma = at(program, 2)
    const text = applyEdits(
      source,
      actionEdits(program, {
        type: 'connect',
        from: split.id,
        port: 'result:b',
        to: suma.id,
        slot: 'left',
      }).edits,
    )
    expect(text).toBe('a, b = f()\nx = b + 2\n')
  })

  it('un puerto de un nombre que el nodo no define no conecta', () => {
    const source = 'a, b = f()\nx = 1 + 2\n'
    const program = parse(source)
    const edits = actionEdits(program, {
      type: 'connect',
      from: at(program, 1).id,
      port: 'result:zzz',
      to: at(program, 2).id,
      slot: 'left',
    }).edits
    expect(edits).toEqual([])
  })
})
