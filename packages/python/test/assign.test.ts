import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyEdits, editsFor } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

/**
 * Lo que no tiene editor propio (`y = x`, `self.a = b`, `z = a and b`) se enseña como un destino y un
 * valor: el valor se escribe y acepta chips; un destino que es un nombre se renombra.
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

describe('una asignación sin editor propio', () => {
  it('copiar un valor: destino y valor', () => {
    const node = at(parse('a = 1\ny = a\n'), 2)
    expect(node.control).toEqual({ kind: 'assign', destination: 'y', value: 'a' })
    expect(node.provides).toBe('y')
  })

  it('un atributo o un elemento como destino', () => {
    const program = parse('def f(self, n):\n    self.n = n\n    xs = [1]\n    xs[0] = n\n')
    expect(at(program, 2).control).toEqual({ kind: 'assign', destination: 'self.n', value: 'n' })
    expect(at(program, 4).control).toEqual({ kind: 'assign', destination: 'xs[0]', value: 'n' })
    expect(at(program, 2).provides).toBeUndefined()
  })

  it('el valor acepta un cable: es un campo con su puerto', () => {
    const program = parse('a = 1\ny = a\n')
    const node = at(program, 2)
    expect(Object.keys(node.inputs ?? {})).toEqual(['value'])
    expect(
      program.edges.some(
        (e) => e.to === node.id && e.toPort === 'value' && e.relation !== 'sequence',
      ),
    ).toBe(true)
  })

  it('un destino que lee nombres también los enlaza, por su propio campo', () => {
    const program = parse('xs = [1]\ni = 0\nv = 3\nxs[i] = v\n')
    const node = at(program, 4)
    expect(Object.keys(node.inputs ?? {})).toEqual(expect.arrayContaining(['destination', 'value']))
    const reads = program.edges.filter((e) => e.to === node.id && e.toPort === 'destination')
    expect(reads.length).toBeGreaterThan(0)
  })

  it('un destino que es un nombre se renombra; uno que no lo es se reescribe', () => {
    const named = at(parse('a = 1\ny = a\nprint(y)\n'), 2)
    expect(named.renames).toEqual({ destination: 'y' })
    expect(named.sources?.['destination']).toBeUndefined()
    const complex = at(parse('self.n = a and m\n'), 1)
    expect(complex.renames?.['destination']).toBeUndefined()
    expect(complex.sources?.['destination']).toBeDefined()
  })

  it('escribir el valor y el destino de vuelta', () => {
    const source = 'a = 1\nb = 2\ny = a\nself.n = a\n'
    const program = parse(source)
    const y = at(program, 3)
    const valor = applyEdits(source, editsFor(y, { kind: 'assign', destination: 'y', value: 'b' }))
    expect(valor).toBe('a = 1\nb = 2\ny = b\nself.n = a\n')
    const attr = at(program, 4)
    const destino = applyEdits(
      source,
      editsFor(attr, { kind: 'assign', destination: 'self.m', value: 'a' }),
    )
    expect(destino).toBe('a = 1\nb = 2\ny = a\nself.m = a\n')
  })

  it('renombrar el destino lo cambia en todos sus usos', () => {
    const source = 'a = 1\ny = a\nprint(y)\n'
    const y = at(parse(source), 2)
    const text = applyEdits(source, editsFor(y, { kind: 'assign', destination: 'z', value: 'a' }))
    expect(text).toBe('a = 1\nz = a\nprint(z)\n')
  })

  it('una asignación de varios nombres define cada uno', () => {
    const program = parse('a, b = f()\nprint(a, b)\n')
    const nodo = at(program, 1)
    expect(
      program.edges.filter((e) => e.from === nodo.id && e.relation !== 'sequence'),
    ).not.toEqual([])
  })

  it('asignar un atributo no redefine el objeto: self sigue saliendo del parámetro', () => {
    const program = parse('def f(self, a):\n    self.x = a\n    self.y = a and 1\n')
    const def = program.nodes.find((n) => n.label === 'f')
    const segundo = at(program, 3)
    const lee = program.edges.filter(
      (e) => e.to === segundo.id && e.toPort === 'destination' && e.relation !== 'sequence',
    )
    expect(lee.length).toBeGreaterThan(0)
    expect(lee.every((e) => e.from === def?.id && e.fromPort === 'param:self')).toBe(true)
  })

  it('lo que ya tenía editor lo conserva', () => {
    const program = parse('a = 1\nb = a + 2\nc = f(a)\nd = [a]\n')
    expect(at(program, 2).control?.kind).toBe('expression')
    expect(at(program, 3).control?.kind).toBe('args')
    expect(at(program, 4).control?.kind).toBe('list')
  })
})
