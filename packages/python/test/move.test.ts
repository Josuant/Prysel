import { createRequire } from 'node:module'
import path from 'node:path'
import type { NodeAction } from '@prysel/morphology'
import { beforeAll, describe, expect, it } from 'vitest'
import { actionEdits, applyEdits } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

/**
 * Arrastrar un nodo dentro o fuera de una función mueve su sentencia en el archivo, cambiándole la
 * sangría, y conectar algo al puerto de retorno de una función escribe su \`return\`.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parser: Awaited<ReturnType<typeof createPythonParser>>
let parse: (source: string) => Program

beforeAll(async () => {
  parser = await createPythonParser({
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
const at = (program: Program, line: number): ProgramNode => {
  const node = program.nodes.find((n) => n.line === line)
  if (!node) throw new Error(`sin nodo en la línea ${line}`)
  return node
}

function act(source: string, make: (program: Program) => NodeAction) {
  const program = parse(source)
  const change = actionEdits(program, make(program))
  const text = applyEdits(source, change.edits)
  return { text, program: parse(text), change }
}
const valid = (text: string) => !parser.parse(text).rootNode.hasError

describe('mover un nodo dentro de una función', () => {
  it('al final de su cuerpo, con la sangría del cuerpo', () => {
    const { text } = act('x = 1\n\n\ndef f():\n    y = 2\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      into: find(p, 'f').id,
    }))
    expect(text).toBe('\n\ndef f():\n    y = 2\n    x = 1\n')
  })

  it('sustituye un pass en vez de dejarlo colgando', () => {
    const { text } = act('x = 1\ndef f():\n    pass\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      into: find(p, 'f').id,
    }))
    expect(text).toBe('def f():\n    x = 1\n')
    expect(valid(text)).toBe(true)
  })

  it('una sentencia con cuerpo se lleva todo lo que tiene dentro, reindentado', () => {
    const { text } = act('for i in range(3):\n    print(i)\ndef f():\n    y = 2\n', (p) => ({
      type: 'move',
      id: at(p, 1).id,
      into: find(p, 'f').id,
    }))
    expect(text).toBe('def f():\n    y = 2\n    for i in range(3):\n        print(i)\n')
    expect(valid(text)).toBe(true)
  })

  it('los comentarios pegados encima se van con ella', () => {
    const { text } = act('# el total\nx = 1\ndef f():\n    y = 2\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      into: find(p, 'f').id,
    }))
    expect(text).toBe('def f():\n    y = 2\n    # el total\n    x = 1\n')
  })

  it('queda seleccionada donde ha ido a parar', () => {
    const { change, program } = act('x = 1\ndef f():\n    y = 2\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      into: find(p, 'f').id,
    }))
    const line = change.select?.line
    expect(program.nodes.find((n) => n.line === line)?.label).toBe('x')
  })
})

describe('sacar un nodo de una función', () => {
  it('detrás de la función, con la sangría del archivo', () => {
    const { text } = act('def f():\n    y = 2\n    z = 3\n', (p) => ({
      type: 'move',
      id: find(p, 'z').id,
      after: find(p, 'f').id,
    }))
    expect(text).toBe('def f():\n    y = 2\nz = 3\n')
    expect(valid(text)).toBe(true)
  })

  it('si era lo único que había, la función queda con un pass', () => {
    const { text } = act('def f():\n    y = 2\n', (p) => ({
      type: 'move',
      id: find(p, 'y').id,
      after: find(p, 'f').id,
    }))
    expect(text).toBe('def f():\n    pass\ny = 2\n')
    expect(valid(text)).toBe(true)
  })

  it('de una función a otra', () => {
    const { text } = act('def f():\n    y = 2\n\n\ndef g():\n    pass\n', (p) => ({
      type: 'move',
      id: find(p, 'y').id,
      into: find(p, 'g').id,
    }))
    expect(text).toBe('def f():\n    pass\n\n\ndef g():\n    y = 2\n')
    expect(valid(text)).toBe(true)
  })

  it('conserva CRLF', () => {
    const { text } = act('def f():\r\n    y = 2\r\n    z = 3\r\n', (p) => ({
      type: 'move',
      id: find(p, 'z').id,
      after: find(p, 'f').id,
    }))
    expect(text).toBe('def f():\r\n    y = 2\r\nz = 3\r\n')
  })
})

describe('mover no rompe el programa', () => {
  const none = (source: string, make: (p: Program) => NodeAction) =>
    expect(act(source, make).change.edits).toEqual([])

  it('una función no se mete dentro de sí misma, ni detrás de algo suyo', () => {
    none('def f():\n    y = 2\n', (p) => ({
      type: 'move',
      id: find(p, 'f').id,
      into: find(p, 'f').id,
    }))
    none('def f():\n    y = 2\n', (p) => ({
      type: 'move',
      id: find(p, 'f').id,
      after: find(p, 'y').id,
    }))
  })

  it('un nodo no se pone detrás de sí mismo', () => {
    none('x = 1\n', (p) => ({ type: 'move', id: find(p, 'x').id, after: find(p, 'x').id }))
  })

  it('un origen o un destino que no existen no hacen nada', () => {
    none('x = 1\n', (p) => ({ type: 'move', id: 'fantasma', after: find(p, 'x').id }))
    none('x = 1\n', (p) => ({ type: 'move', id: find(p, 'x').id, into: 'fantasma' }))
  })

  it('una sentencia que comparte línea con otra no se mueve', () => {
    none('if True: x = 1\ndef f():\n    pass\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      into: find(p, 'f').id,
    }))
  })

  it('el resultado sigue siendo Python válido en un caso con anidamiento', () => {
    const { text } = act(
      'def f():\n    if True:\n        a = 1\n        b = 2\n    c = 3\n',
      (p) => ({ type: 'move', id: find(p, 'b').id, after: find(p, 'c').id }),
    )
    expect(valid(text)).toBe(true)
    expect(text).toBe('def f():\n    if True:\n        a = 1\n    c = 3\n    b = 2\n')
  })
})

describe('conectar al retorno de una función', () => {
  it('añade el return al final si no había', () => {
    const { text } = act('def f(a, b):\n    s = a + b\n', (p) => ({
      type: 'connect',
      from: find(p, 's').id,
      to: find(p, 'f').id,
      slot: 'return',
    }))
    expect(text).toBe('def f(a, b):\n    s = a + b\n    return s\n')
  })

  it('cambia lo que devuelve si ya devolvía otra cosa', () => {
    const { text } = act('def f(a, b):\n    s = a + b\n    t = a - b\n    return s\n', (p) => ({
      type: 'connect',
      from: find(p, 't').id,
      to: find(p, 'f').id,
      slot: 'return',
    }))
    expect(text).toBe('def f(a, b):\n    s = a + b\n    t = a - b\n    return t\n')
  })

  it('sustituye entero un return que era una operación', () => {
    const { text } = act('def f(a, b):\n    s = a * b\n    return a + b\n', (p) => ({
      type: 'connect',
      from: find(p, 's').id,
      to: find(p, 'f').id,
      slot: 'return',
    }))
    expect(text).toBe('def f(a, b):\n    s = a * b\n    return s\n')
  })

  it('un parámetro también se puede devolver', () => {
    const { text } = act('def f(a, b):\n    s = a + b\n', (p) => ({
      type: 'connect',
      from: find(p, 'f').id,
      port: 'param:b',
      to: find(p, 'f').id,
      slot: 'return',
    }))
    expect(text).toBe('def f(a, b):\n    s = a + b\n    return b\n')
  })

  it('una función vacía (solo pass) recibe el return en su lugar', () => {
    const { text } = act('x = 1\ndef f():\n    pass\n', (p) => ({
      type: 'connect',
      from: find(p, 'x').id,
      to: find(p, 'f').id,
      slot: 'return',
    }))
    // `x` no está dentro de `f`: no se devuelve algo de fuera por un puerto de la función.
    expect(text).toBe('x = 1\ndef f():\n    pass\n')
  })

  it('no devuelve algo que no se calcula dentro de la función', () => {
    const { change } = act('x = 1\ndef f(a):\n    s = a\n', (p) => ({
      type: 'connect',
      from: find(p, 'x').id,
      to: find(p, 'f').id,
      slot: 'return',
    }))
    expect(change.edits).toEqual([])
  })

  it('el mismo valor que ya devuelve: no hay nada que cambiar', () => {
    const { change } = act('def f(a):\n    s = a\n    return s\n', (p) => ({
      type: 'connect',
      from: find(p, 's').id,
      to: find(p, 'f').id,
      slot: 'return',
    }))
    expect(change.edits).toEqual([])
  })
})

describe('lo que se mete en una función va antes de su return', () => {
  it('mover un nodo dentro', () => {
    const { text } = act('x = 3\ndef f(a):\n    s = a\n    return s\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      into: find(p, 'f').id,
    }))
    expect(text).toBe('def f(a):\n    s = a\n    x = 3\n    return s\n')
    expect(valid(text)).toBe(true)
  })

  it('añadir dentro', () => {
    const { text } = act('def f(a):\n    s = a\n    return s\n', (p) => ({
      type: 'add',
      template: 'print',
      into: find(p, 'f').id,
      connect: { from: find(p, 'f').id, port: 'param:a' },
    }))
    expect(text).toBe('def f(a):\n    s = a\n    print(a)\n    return s\n')
  })

  it('si el return es lo único que hay, lo nuevo va encima', () => {
    const { text } = act('x = 3\ndef f(a):\n    return a\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      into: find(p, 'f').id,
    }))
    expect(text).toBe('def f(a):\n    x = 3\n    return a\n')
    expect(valid(text)).toBe(true)
  })

  it('un return dentro de un if no cuenta: solo el que cierra el cuerpo', () => {
    const { text } = act('x = 3\ndef f(a):\n    if a:\n        return 1\n    y = 2\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      into: find(p, 'f').id,
    }))
    expect(text).toBe('def f(a):\n    if a:\n        return 1\n    y = 2\n    x = 3\n')
  })
})
