import { createRequire } from 'node:module'
import path from 'node:path'
import type { NodeAction } from '@prysel/morphology'
import { beforeAll, describe, expect, it } from 'vitest'
import { actionEdits, applyEdits } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

/**
 * `class` ya no es código opaco: es un territorio como una función, con sus atributos y sus métodos
 * dentro, y se crea llamándola.
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

const CLASS = [
  'class Perro(Animal):',
  '    """Un perro."""',
  '    patas = 4',
  '    def __init__(self, nombre, edad):',
  '        self.nombre = nombre',
  '        self.edad = edad',
  '    def ladrar(self, veces):',
  '        return veces',
  'p = Perro("Rex", 3)',
  'print(p)',
  '',
].join('\n')

const kind = (program: Program, id: ProgramNode['kind']): ProgramNode => {
  const node = program.nodes.find((n) => n.kind === id)
  if (!node) throw new Error(`sin nodo de tipo ${id}`)
  return node
}
const at = (program: Program, line: number): ProgramNode => {
  const node = program.nodes.find((n) => n.line === line)
  if (!node) throw new Error(`sin nodo en la línea ${line}`)
  return node
}
function act(source: string, make: (program: Program) => NodeAction) {
  const program = parse(source)
  return applyEdits(source, actionEdits(program, make(program)).edits)
}

describe('una clase', () => {
  it('es un territorio con sus atributos y sus métodos dentro, no código opaco', () => {
    const program = parse(CLASS)
    const clase = kind(program, 'abstraction.class')
    const methods = program.nodes.filter((n) => n.kind === 'abstraction.collapsed')
    expect(methods.map((m) => m.label)).toEqual(['__init__', 'ladrar'])
    expect(clase.contains).toEqual(expect.arrayContaining(methods.map((m) => m.id)))
    expect(program.unsupported).toEqual([])
  })

  it('enseña de quién hereda y qué recibe al crearse (los parámetros de su __init__, sin self)', () => {
    const clase = kind(parse(CLASS), 'abstraction.class')
    expect(clase.control).toEqual({ kind: 'class', bases: 'Animal', params: ['nombre', 'edad'] })
  })

  it('su docstring es su explicación', () => {
    expect(kind(parse(CLASS), 'abstraction.class').note).toBe('Un perro.')
  })

  it('sin paréntesis no hereda de nadie', () => {
    const clase = kind(parse('class A:\n    x = 1\n'), 'abstraction.class')
    expect(clase.control).toEqual({ kind: 'class', bases: '', params: [] })
  })

  it('se crea llamándola: la llamada lleva a la clase y nombra sus argumentos', () => {
    const program = parse(CLASS)
    const clase = kind(program, 'abstraction.class')
    const llamada = at(program, 9)
    expect(llamada.calls).toBe(clase.id)
    expect(llamada.control).toMatchObject({
      kind: 'args',
      target: 'Perro',
      args: [
        { name: 'nombre', value: '"Rex"' },
        { name: 'edad', value: '3' },
      ],
    })
  })

  it('lo que hereda se lee de lo que hay antes', () => {
    const program = parse('class Animal:\n    pass\nclass Perro(Animal):\n    x = 1\n')
    const perro = program.nodes.find((n) => n.label === 'Perro')
    const animal = program.nodes.find((n) => n.label === 'Animal')
    expect(
      program.edges.some(
        (e) => e.from === animal?.id && e.to === perro?.id && e.toPort === 'bases',
      ),
    ).toBe(true)
  })

  it('los métodos no se conocen como funciones sueltas ni se confunden entre clases', () => {
    const program = parse(
      'class A:\n    def __init__(self, x):\n        pass\nclass B:\n    def __init__(self, y, z):\n        pass\nb = B(1, 2)\n',
    )
    const b = program.nodes.find((n) => n.label === 'b')
    expect(b?.control).toMatchObject({ args: [{ name: 'y' }, { name: 'z' }] })
    const clases = program.nodes.filter((n) => n.kind === 'abstraction.class')
    expect(clases.map((c) => c.control)).toEqual([
      { kind: 'class', bases: '', params: ['x'] },
      { kind: 'class', bases: '', params: ['y', 'z'] },
    ])
  })

  it('lo que se define en su cuerpo no se ve desde fuera (es de la clase)', () => {
    const program = parse(CLASS)
    expect(at(program, 10).scope).not.toContain('patas')
  })

  it('se renombra en todos sus usos', () => {
    const text = act(CLASS, (p) => ({
      type: 'rename',
      id: kind(p, 'abstraction.class').id,
      to: 'Can',
    }))
    expect(text).toContain('class Can(Animal):')
    expect(text).toContain('p = Can("Rex", 3)')
  })

  it('las bases se reescriben', () => {
    const program = parse(CLASS)
    const source = kind(program, 'abstraction.class').sources?.['bases']
    expect(program.source.slice(source?.start, source?.end)).toBe('Animal')
  })
})

describe('los decoradores', () => {
  const DECORATED = [
    'class A:',
    '    @property',
    '    def nombre(self):',
    '        return 1',
    '    x = 2',
    '',
  ].join('\n')

  it('una definición con decoradores sigue siendo una definición', () => {
    const program = parse(DECORATED)
    expect(program.unsupported).toEqual([])
    const metodo = program.nodes.find((n) => n.label === 'nombre')
    expect(metodo?.kind).toBe('abstraction.collapsed')
    expect(metodo?.contains).toHaveLength(1)
  })

  it('su sentencia incluye el decorador: eliminarla se lo lleva', () => {
    const text = act(DECORATED, (p) => ({
      type: 'delete',
      id: p.nodes.find((n) => n.label === 'nombre')?.id ?? '',
    }))
    expect(text).toBe('class A:\n    x = 2\n')
  })

  it('se puede meter algo dentro de una función decorada', () => {
    const text = act('@cache\ndef f(a):\n    return a\nx = 1\n', (p) => ({
      type: 'move',
      id: p.nodes.find((n) => n.label === 'x')?.id ?? '',
      into: p.nodes.find((n) => n.label === 'f')?.id ?? '',
    }))
    expect(text).toBe('@cache\ndef f(a):\n    x = 1\n    return a\n')
  })
})
