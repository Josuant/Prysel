import { createRequire } from 'node:module'
import path from 'node:path'
import type { NodeAction } from '@prysel/morphology'
import { channelOf } from '@prysel/spatial'
import { beforeAll, describe, expect, it } from 'vitest'
import { actionEdits, applyEdits } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

/**
 * Un bucle envuelve lo que repite: su variable es un puerto, su cuerpo (a cualquier profundidad)
 * es suyo, y `break` / `continue` se conectan al bucle que afectan.
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

const find = (program: Program, label: string): ProgramNode => {
  const node = program.nodes.find((n) => n.label === label)
  if (!node) throw new Error(`sin nodo ${label}`)
  return node
}
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
  const change = actionEdits(program, make(program))
  return { text: applyEdits(source, change.edits), change }
}

describe('un bucle for', () => {
  const SOURCE = 'total = 0\nfor n in range(10):\n    total = total + n\n'

  it('su variable de iteración es un puerto, como un parámetro lo es de una función', () => {
    const loop = kind(parse(SOURCE), 'control.loop')
    expect(loop.params).toEqual(['n'])
    expect(loop.provides).toBe('n')
  })

  it('lo que la usa dentro sale por ese puerto', () => {
    const program = parse(SOURCE)
    const loop = kind(program, 'control.loop')
    const cables = program.edges.filter((e) => e.from === loop.id && e.fromPort)
    expect(cables.map((e) => e.fromPort)).toEqual(['param:n'])
  })

  it('su cuerpo es suyo a cualquier profundidad: las ramas de un if también', () => {
    const program = parse(
      'for i in r:\n    if i > 1:\n        a = 1\n    else:\n        b = 2\n    c = 3\n',
    )
    const loop = kind(program, 'control.loop')
    expect(loop.contains).toEqual(
      expect.arrayContaining([find(program, 'a').id, find(program, 'b').id, find(program, 'c').id]),
    )
  })

  it('un bucle dentro de otro: el de fuera también envuelve lo del de dentro', () => {
    const program = parse('for i in a:\n    for j in b:\n        x = 1\n')
    const [outer, inner] = program.nodes.filter((n) => n.kind === 'control.loop')
    expect(outer?.contains).toEqual(expect.arrayContaining([inner?.id, find(program, 'x').id]))
    expect(inner?.contains).toEqual([find(program, 'x').id])
  })

  it('la secuencia que recorre acepta un cable', () => {
    const loop = kind(parse(SOURCE), 'control.loop')
    expect(Object.keys(loop.inputs ?? {})).toEqual(['iterable'])
  })

  it('se puede conectar su variable a lo que hay dentro, por su puerto', () => {
    const { text } = act('for i in range(3):\n    c = 0 + 0\n', (p) => ({
      type: 'connect',
      from: kind(p, 'control.loop').id,
      port: 'param:i',
      to: find(p, 'c').id,
      slot: 'left',
    }))
    expect(text).toBe('for i in range(3):\n    c = i + 0\n')
  })
})

describe('un bucle while', () => {
  const SOURCE = 'n = 5\nwhile n > 0:\n    n = n - 1\n'

  it('enseña su condición en un editor, con su campo conectable', () => {
    const loop = kind(parse(SOURCE), 'control.loop')
    expect(loop.control).toMatchObject({ kind: 'loop', while: true, iterable: 'n > 0' })
    expect(Object.keys(loop.inputs ?? {})).toEqual(['iterable'])
  })

  it('envuelve su cuerpo', () => {
    const program = parse(SOURCE)
    expect(kind(program, 'control.loop').contains).toEqual([at(program, 3).id])
  })

  it('lo que la condición lee llega a su campo', () => {
    const program = parse(SOURCE)
    const loop = kind(program, 'control.loop')
    expect(program.edges.some((e) => e.to === loop.id && e.toPort === 'iterable')).toBe(true)
  })

  it('la condición se reescribe desde el diagrama', () => {
    const { text } = act(SOURCE, (p) => ({
      type: 'connect',
      from: find(p, 'n').id,
      to: kind(p, 'control.loop').id,
      slot: 'iterable',
    }))
    expect(text).toBe('n = 5\nwhile n:\n    n = n - 1\n')
  })
})

describe('break y continue', () => {
  const SOURCE = [
    'for n in range(10):',
    '    if n % 2 == 0:',
    '        continue',
    '    if n > 7:',
    '        break',
    '',
  ].join('\n')

  it('son nodos propios, no código opaco', () => {
    const program = parse(SOURCE)
    expect(kind(program, 'control.break').label).toBe('salir')
    expect(kind(program, 'control.continue').label).toBe('siguiente')
    expect(program.unsupported).toEqual([])
  })

  it('break se conecta a la salida del bucle y continue a su siguiente vuelta', () => {
    const program = parse(SOURCE)
    const loop = kind(program, 'control.loop')
    const to = (id: ProgramNode['kind']) =>
      program.edges.find((e) => e.from === kind(program, id).id && e.to === loop.id)
    expect(to('control.break')?.toPort).toBe('exit')
    expect(to('control.continue')?.toPort).toBe('next')
  })

  it('esos cables son de control', () => {
    const program = parse(SOURCE)
    const loop = kind(program, 'control.loop')
    const cables = program.edges.filter((e) => e.to === loop.id && e.toPort)
    expect(cables).toHaveLength(2)
    expect(cables.every((e) => channelOf(e) === 'control')).toBe(true)
  })

  it('en bucles anidados afectan al más cercano', () => {
    const program = parse('for i in a:\n    for j in b:\n        break\n')
    const [outer, inner] = program.nodes.filter((n) => n.kind === 'control.loop')
    const cable = program.edges.find((e) => e.from === kind(program, 'control.break').id)
    expect(cable?.to).toBe(inner?.id)
    expect(cable?.to).not.toBe(outer?.id)
  })

  it('un break dentro de una función no afecta al bucle que la rodea', () => {
    const program = parse('for i in a:\n    def f():\n        break\n')
    expect(program.edges.some((e) => e.from === kind(program, 'control.break').id)).toBe(false)
  })
})

describe('meter algo en un bucle', () => {
  it('lo escribe en su cuerpo, sustituyendo un pass', () => {
    const { text } = act('x = 1\nfor i in r:\n    pass\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      into: kind(p, 'control.loop').id,
    }))
    expect(text).toBe('for i in r:\n    x = 1\n')
  })

  it('va antes de un break o continue final: detrás nunca se ejecutaría', () => {
    const { text } = act('x = 1\nfor i in r:\n    a = 2\n    break\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      into: kind(p, 'control.loop').id,
    }))
    expect(text).toBe('for i in r:\n    a = 2\n    x = 1\n    break\n')
  })

  it('crear algo desde la variable del bucle lo pone dentro', () => {
    const { text } = act('for i in r:\n    a = 2\n', (p) => ({
      type: 'add',
      template: 'print',
      into: kind(p, 'control.loop').id,
      connect: { from: kind(p, 'control.loop').id, port: 'param:i' },
    }))
    expect(text).toBe('for i in r:\n    a = 2\n    print(i)\n')
  })
})
