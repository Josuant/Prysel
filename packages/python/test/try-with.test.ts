import { createRequire } from 'node:module'
import path from 'node:path'
import type { NodeAction } from '@prysel/morphology'
import { beforeAll, describe, expect, it } from 'vitest'
import { actionEdits, applyEdits, editsFor } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

/**
 * `with` y `try` ya no son código opaco: son territorios con su cuerpo dentro, sus nombres son
 * puertos y lo que se define dentro se ve desde fuera.
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

const WITH = 'with open("a.txt") as f:\n    datos = f.read()\n    print(datos)\nprint("fin")\n'

describe('with', () => {
  it('es un territorio con su cuerpo dentro, no código opaco', () => {
    const program = parse(WITH)
    const node = kind(program, 'control.with')
    expect(node.contains).toEqual([at(program, 2).id, at(program, 3).id])
    expect(program.unsupported).toEqual([])
  })

  it('enseña el recurso y el nombre con el que se usa', () => {
    const node = kind(parse(WITH), 'control.with')
    expect(node.control).toEqual({ kind: 'with', context: 'open("a.txt")', name: 'f' })
    expect(node.label).toBe('con f')
  })

  it('su nombre es un puerto, como la variable de un bucle', () => {
    const program = parse(WITH)
    const node = kind(program, 'control.with')
    expect(node.params).toEqual(['f'])
    const uses = program.edges.filter((e) => e.from === node.id && e.fromPort === 'param:f')
    expect(uses.length).toBeGreaterThan(0)
  })

  it('lo que se define dentro se ve desde fuera, como en Python', () => {
    const program = parse(WITH)
    const outside = at(program, 4)
    expect(outside.scope).toContain('datos')
  })

  it('sin nombre (with lock:) no lleva puerto', () => {
    const node = kind(parse('with lock:\n    a = 1\n'), 'control.with')
    expect(node.control).toEqual({ kind: 'with', context: 'lock', name: '' })
    expect(node.params).toBeUndefined()
  })

  it('con varios recursos enseña su código y sigue siendo un territorio', () => {
    const program = parse('with a as x, b as y:\n    z = x\n')
    const node = kind(program, 'control.with')
    expect(node.control).toBeUndefined()
    expect(node.params).toEqual(['x', 'y'])
    expect(node.contains).toHaveLength(1)
  })

  it('el recurso se lee de lo que hay antes, no del nombre que abre', () => {
    const program = parse('f = 1\nwith open(f) as f:\n    a = f\n')
    const node = kind(program, 'control.with')
    const reads = program.edges.filter((e) => e.to === node.id && e.toPort === 'context')
    expect(reads).toHaveLength(1)
  })

  it('su nombre se renombra en todos sus usos desde el editor', () => {
    const program = parse(WITH)
    const node = kind(program, 'control.with')
    const next = { kind: 'with' as const, context: 'open("a.txt")', name: 'fichero' }
    const text = applyEdits(WITH, editsFor(node, next))
    expect(text).toBe(
      'with open("a.txt") as fichero:\n    datos = fichero.read()\n    print(datos)\nprint("fin")\n',
    )
  })
})

const TRY = [
  'try:',
  '    x = int(dato)',
  '    y = 1 / x',
  'except ValueError as e:',
  '    print(e)',
  'except ZeroDivisionError:',
  '    y = 0',
  'else:',
  '    z = 1',
  'finally:',
  '    print("fin")',
  'print(y)',
  '',
].join('\n')

describe('try', () => {
  it('es un territorio con su intento y sus cláusulas dentro', () => {
    const program = parse(TRY)
    const node = kind(program, 'control.try')
    const kinds = program.nodes
      .filter((n) => node.contains?.includes(n.id))
      .map((n) => n.kind)
      .filter((k) => k === 'control.except' || k === 'control.clause')
    expect(kinds).toEqual(['control.except', 'control.except', 'control.clause', 'control.clause'])
    expect(program.unsupported).toEqual([])
  })

  it('cada except dice qué error atrapa y con qué nombre', () => {
    const program = parse(TRY)
    const handlers = program.nodes.filter((n) => n.kind === 'control.except')
    expect(handlers.map((h) => h.control)).toEqual([
      { kind: 'handler', type: 'ValueError', name: 'e' },
      { kind: 'handler', type: 'ZeroDivisionError', name: '' },
    ])
    expect(handlers[0]?.params).toEqual(['e'])
  })

  it('un except sin tipo atrapa cualquier error', () => {
    const program = parse('try:\n    a = f()\nexcept:\n    pass\n')
    expect(kind(program, 'control.except').control).toEqual({
      kind: 'handler',
      type: '',
      name: '',
    })
  })

  it('cada cláusula lleva su cuerpo dentro', () => {
    const program = parse(TRY)
    const handler = program.nodes.find((n) => n.kind === 'control.except')
    expect(handler?.contains).toEqual([at(program, 5).id])
    const clauses = program.nodes.filter((n) => n.kind === 'control.clause')
    expect(clauses.map((c) => c.label)).toEqual(['si no falla', 'al final'])
    expect(clauses.map((c) => c.contains?.length)).toEqual([1, 1])
  })

  it('el nombre del except se lee dentro de su cuerpo', () => {
    const program = parse(TRY)
    const handler = program.nodes.find((n) => n.kind === 'control.except')
    const use = program.edges.find((e) => e.from === handler?.id && e.fromPort === 'param:e')
    expect(use?.to).toBe(at(program, 5).id)
  })

  it('lo que se define dentro se ve después, y la sentencia siguiente va tras el try', () => {
    const program = parse(TRY)
    expect(at(program, 12).scope).toEqual(expect.arrayContaining(['x', 'y']))
    const trying = kind(program, 'control.try')
    expect(
      program.edges.some(
        (e) => e.relation === 'sequence' && e.from === trying.id && e.to === at(program, 12).id,
      ),
    ).toBe(true)
  })

  it('las cláusulas van en cadena por orden de lectura', () => {
    const program = parse(TRY)
    const order = program.edges
      .filter((e) => e.relation === 'sequence')
      .map(
        (e) =>
          `${program.nodes.find((n) => n.id === e.from)?.line}→${program.nodes.find((n) => n.id === e.to)?.line}`,
      )
    expect(order).toEqual(expect.arrayContaining(['3→4', '4→6', '6→8', '8→10']))
  })
})

describe('escribir de vuelta', () => {
  it('el tipo de error de un except se reescribe', () => {
    const program = parse('try:\n    a = f()\nexcept ValueError:\n    pass\n')
    const handler = kind(program, 'control.except')
    const type = handler.sources?.['type']
    expect(type).toBeDefined()
    expect(program.source.slice(type?.start, type?.end)).toBe('ValueError')
  })

  it('las plantillas try y with son Python válido y añaden nodos', () => {
    for (const template of ['try', 'with'] as const) {
      const source = 'a = 1\n'
      const text = act(source, () => ({ type: 'add', template }))
      const program = parse(text)
      expect(program.unsupported, template).toEqual([])
      expect(program.nodes.length, template).toBeGreaterThan(1)
    }
  })

  it('mete algo al principio del intento y al principio de un except', () => {
    const source = 'try:\n    a = f()\nexcept E:\n    b = g()\nz = h()\n'
    const intento = act(source, (p) => ({
      type: 'move',
      id: at(p, 5).id,
      into: kind(p, 'control.try').id,
      start: true,
    }))
    expect(intento).toBe('try:\n    z = h()\n    a = f()\nexcept E:\n    b = g()\n')
    const fallo = act(source, (p) => ({
      type: 'move',
      id: at(p, 5).id,
      into: kind(p, 'control.except').id,
      start: true,
    }))
    expect(fallo).toBe('try:\n    a = f()\nexcept E:\n    z = h()\n    b = g()\n')
  })

  it('una cláusula no se mueve por sí sola ni se pone nada «detrás» de ella', () => {
    const source = 'try:\n    a = f()\nexcept E:\n    b = g()\nz = h()\n'
    expect(
      act(source, (p) => ({ type: 'move', id: kind(p, 'control.except').id, after: at(p, 5).id })),
    ).toBe(source)
    expect(
      act(source, (p) => ({ type: 'move', id: at(p, 5).id, after: kind(p, 'control.except').id })),
    ).toBe(source)
  })

  it('eliminar el intento entero se lleva sus cláusulas', () => {
    const text = act('try:\n    a = f()\nexcept E:\n    b = g()\nz = h()\n', (p) => ({
      type: 'delete',
      id: kind(p, 'control.try').id,
    }))
    expect(text).toBe('z = h()\n')
  })
})
