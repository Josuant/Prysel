import { createRequire } from 'node:module'
import path from 'node:path'
import type { NodeAction } from '@prysel/morphology'
import { beforeAll, describe, expect, it } from 'vitest'
import { actionEdits, applyEdits, editsFor } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

/**
 * `match` y `except*` ya no son código opaco: un `match` es un territorio con lo que compara en la
 * cabecera y un marco por caso dentro (como las cláusulas de un `try`), y un `except*` dice que atrapa
 * dentro de un grupo de errores.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => Program
let hasError: (source: string) => boolean

beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
  hasError = (source: string) => parser.parse(source).rootNode.hasError
}, 30_000)

const all = (program: Program, id: ProgramNode['kind']): ProgramNode[] =>
  program.nodes.filter((n) => n.kind === id)
const one = (program: Program, id: ProgramNode['kind']): ProgramNode => {
  const node = all(program, id)[0]
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

const MATCH = [
  'orden = "ir"',
  'listo = True',
  'match orden:',
  '    case "ir" | "vamos" if listo:',
  '        print("en marcha")',
  '    case [x, y]:',
  '        print(x + y)',
  '    case _:',
  '        print("¿qué?")',
  '',
].join('\n')

describe('match', () => {
  it('es un territorio con un marco por caso, no código opaco', () => {
    const program = parse(MATCH)
    const match = one(program, 'control.match')
    const cases = all(program, 'control.case')
    expect(cases).toHaveLength(3)
    for (const c of cases) expect(match.contains).toContain(c.id)
    // Lo de dentro de cada caso es suyo.
    expect(cases[0]?.contains).toEqual([at(program, 5).id])
    expect(program.unsupported).toEqual([])
  })

  it('enseña lo que compara, y lee el nombre (un chip puede soltarse ahí)', () => {
    const program = parse(MATCH)
    const match = one(program, 'control.match')
    expect(match.control).toEqual({ kind: 'match', subject: 'orden' })
    expect(match.label).toBe('según orden')
    expect(Object.keys(match.inputs ?? {})).toEqual(['subject'])
    expect(program.edges.some((e) => e.from === at(program, 1).id && e.to === match.id)).toBe(true)
  })

  it('cada caso enseña su patrón y su condición; `case _` es «en otro caso»', () => {
    const cases = all(parse(MATCH), 'control.case')
    expect(cases[0]?.control).toEqual({ kind: 'case', pattern: '"ir" | "vamos"', guard: 'listo' })
    expect(cases[0]?.label).toBe('caso "ir" | "vamos"')
    expect(cases[1]?.control).toEqual({ kind: 'case', pattern: '[x, y]', guard: '' })
    expect(cases[2]?.label).toBe('en otro caso')
  })

  it('la condición de un caso lee sus nombres; el patrón no acepta chips (cambiaría lo que significa)', () => {
    const program = parse(MATCH)
    const first = all(program, 'control.case')[0]
    expect(Object.keys(first?.inputs ?? {})).toEqual(['guard'])
    expect(program.edges.some((e) => e.from === at(program, 2).id && e.to === first?.id)).toBe(true)
  })

  it('los nombres que captura un patrón quedan definidos dentro del caso', () => {
    const program = parse(MATCH)
    const second = all(program, 'control.case')[1]
    expect(second?.params).toEqual(['x', 'y'])
    // `print(x + y)` lee x e y del patrón.
    const inside = at(program, 7)
    expect(program.edges.some((e) => e.from === second?.id && e.to === inside.id)).toBe(true)
  })

  it('un nombre con puntos compara, no captura', () => {
    const program = parse(
      'match c:\n    case Color.ROJO:\n        pass\n    case otro:\n        pass\n',
    )
    const cases = all(program, 'control.case')
    expect(cases[0]?.params ?? []).toEqual([])
    expect(cases[1]?.params).toEqual(['otro'])
  })

  it('editar lo que compara, el patrón o la condición reescribe solo ese trozo', () => {
    const program = parse(MATCH)
    const match = one(program, 'control.match')
    const renamed = applyEdits(MATCH, editsFor(match, { kind: 'match', subject: 'orden.lower()' }))
    expect(renamed).toContain('match orden.lower():')
    const first = all(program, 'control.case')[0] as ProgramNode
    const patched = applyEdits(
      MATCH,
      editsFor(first, { kind: 'case', pattern: '"ir"', guard: 'listo and orden' }),
    )
    expect(patched).toContain('    case "ir" if listo and orden:')
    expect(hasError(patched)).toBe(false)
  })

  it('un caso no se mueve ni se borra dejando un `pass`: es parte del match', () => {
    const program = parse(MATCH)
    const first = all(program, 'control.case')[0] as ProgramNode
    expect(
      actionEdits(program, { type: 'move', id: first.id, after: at(program, 1).id }).edits,
    ).toEqual([])
  })

  it('no se puede meter una sentencia suelta en el cuerpo de un match (solo admite casos)', () => {
    const program = parse(MATCH)
    const match = one(program, 'control.match')
    expect(actionEdits(program, { type: 'add', template: 'print', into: match.id }).edits).toEqual(
      [],
    )
    expect(
      actionEdits(program, { type: 'move', id: at(program, 2).id, into: match.id }).edits,
    ).toEqual([])
  })

  it('sí dentro de un caso', () => {
    const text = act(MATCH, (p) => ({
      type: 'add',
      template: 'print',
      into: all(p, 'control.case')[1]?.id ?? '',
    }))
    expect(hasError(text)).toBe(false)
    expect(all(parse(text), 'control.case')[1]?.contains).toHaveLength(2)
  })
})

describe('except*', () => {
  const GROUP = 'try:\n    f()\nexcept* ValueError as grupo:\n    print(grupo)\n'

  it('es una cláusula de un try, que dice que atrapa dentro de un grupo de errores', () => {
    const handler = one(parse(GROUP), 'control.except')
    expect(handler.control).toEqual({
      kind: 'handler',
      type: 'ValueError',
      name: 'grupo',
      group: true,
    })
    expect(handler.label).toBe('si falla alguno de: ValueError')
  })

  it('un except normal no es de grupo', () => {
    const handler = one(parse('try:\n    f()\nexcept ValueError:\n    pass\n'), 'control.except')
    expect(handler.control).toEqual({ kind: 'handler', type: 'ValueError', name: '' })
  })

  it('cambiar el tipo de error conserva el `*`', () => {
    const handler = one(parse(GROUP), 'control.except')
    const text = applyEdits(
      GROUP,
      editsFor(handler, { kind: 'handler', type: 'KeyError', name: 'grupo', group: true }),
    )
    expect(text).toContain('except* KeyError as grupo:')
  })
})
