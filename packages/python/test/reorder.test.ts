import { createRequire } from 'node:module'
import path from 'node:path'
import type { NodeAction } from '@prysel/morphology'
import { beforeAll, describe, expect, it } from 'vitest'
import { actionEdits, applyEdits } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

/**
 * Reordenar arrastrando un cable de orden: una sentencia detrás de otra, al principio de lo que
 * actúa en un cuerpo, o al principio de uno de los dos caminos de una decisión.
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

function act(source: string, make: (program: Program) => NodeAction) {
  const program = parse(source)
  return applyEdits(source, actionEdits(program, make(program)).edits)
}

describe('detrás de otra sentencia', () => {
  it('reordena dentro del mismo bloque', () => {
    const text = act('a = f()\nb = g()\nc = h()\n', (p) => ({
      type: 'move',
      id: at(p, 3).id,
      after: at(p, 1).id,
    }))
    expect(text).toBe('a = f()\nc = h()\nb = g()\n')
  })

  it('lleva una sentencia a otro bloque, con su sangría', () => {
    const text = act('def f():\n    a = g()\nb = h()\n', (p) => ({
      type: 'move',
      id: at(p, 3).id,
      after: at(p, 2).id,
    }))
    expect(text).toBe('def f():\n    a = g()\n    b = h()\n')
  })
})

describe('al principio de lo que actúa en un cuerpo', () => {
  it('va tras las inicializaciones, para no deshacer sus chips', () => {
    const text = act('def f():\n    n = 0\n    a = g()\n    b = h()\nx = k()\n', (p) => ({
      type: 'move',
      id: at(p, 5).id,
      into: at(p, 1).id,
      start: true,
    }))
    expect(text).toBe('def f():\n    n = 0\n    x = k()\n    a = g()\n    b = h()\n')
  })

  it('un cuerpo con solo inicializaciones lo recibe al final', () => {
    const text = act('def f():\n    n = 0\nx = k()\n', (p) => ({
      type: 'move',
      id: at(p, 3).id,
      into: at(p, 1).id,
      start: true,
    }))
    expect(text).toBe('def f():\n    n = 0\n    x = k()\n')
  })

  it('un bucle también', () => {
    const text = act('for i in r:\n    a = g(i)\nx = k()\n', (p) => ({
      type: 'move',
      id: at(p, 3).id,
      into: at(p, 1).id,
      start: true,
    }))
    expect(text).toBe('for i in r:\n    x = k()\n    a = g(i)\n')
  })
})

describe('a un camino de una decisión', () => {
  const IF = 'if c:\n    a = f()\nelse:\n    b = g()\nz = h()\n'

  it('al principio del camino verdadero', () => {
    const text = act(IF, (p) => ({
      type: 'move',
      id: at(p, 5).id,
      into: at(p, 1).id,
      branch: 'yes',
    }))
    expect(text).toBe('if c:\n    z = h()\n    a = f()\nelse:\n    b = g()\n')
  })

  it('al principio del else', () => {
    const text = act(IF, (p) => ({
      type: 'move',
      id: at(p, 5).id,
      into: at(p, 1).id,
      branch: 'no',
    }))
    expect(text).toBe('if c:\n    a = f()\nelse:\n    z = h()\n    b = g()\n')
  })

  it('un camino que era un pass lo sustituye', () => {
    const text = act('if c:\n    pass\nelse:\n    pass\nz = h()\n', (p) => ({
      type: 'move',
      id: at(p, 5).id,
      into: at(p, 1).id,
      branch: 'yes',
    }))
    expect(text).toBe('if c:\n    z = h()\nelse:\n    pass\n')
  })

  it('un else vacío (pass) también', () => {
    const text = act('if c:\n    a = f()\nelse:\n    pass\nz = h()\n', (p) => ({
      type: 'move',
      id: at(p, 5).id,
      into: at(p, 1).id,
      branch: 'no',
    }))
    expect(text).toBe('if c:\n    a = f()\nelse:\n    z = h()\n')
  })

  it('si no hay else, se crea', () => {
    const text = act('if c:\n    a = f()\nz = h()\n', (p) => ({
      type: 'move',
      id: at(p, 3).id,
      into: at(p, 1).id,
      branch: 'no',
    }))
    expect(text).toBe('if c:\n    a = f()\nelse:\n    z = h()\n')
  })

  it('dentro de una función, con su sangría', () => {
    const text = act('def f():\n    if c:\n        a = g()\n    z = h()\n', (p) => ({
      type: 'move',
      id: at(p, 4).id,
      into: at(p, 2).id,
      branch: 'no',
    }))
    expect(text).toBe('def f():\n    if c:\n        a = g()\n    else:\n        z = h()\n')
  })

  it('pasar algo de un camino al otro de la misma decisión', () => {
    const text = act(IF, (p) => ({
      type: 'move',
      id: at(p, 2).id,
      into: at(p, 1).id,
      branch: 'no',
    }))
    expect(text).toBe('if c:\n    pass\nelse:\n    a = f()\n    b = g()\nz = h()\n')
  })

  it('no vale para algo que no es una decisión', () => {
    const source = 'a = f()\nb = g()\n'
    expect(
      act(source, (p) => ({ type: 'move', id: at(p, 2).id, into: at(p, 1).id, branch: 'yes' })),
    ).toBe(source)
  })
})

describe('crear desde un puerto de orden', () => {
  it('un break al principio del camino verdadero de una decisión', () => {
    const text = act('for i in r:\n    if i:\n        pass\n    a = f()\n', (p) => ({
      type: 'add',
      template: 'break',
      into: at(p, 2).id,
      branch: 'yes',
    }))
    expect(text).toBe('for i in r:\n    if i:\n        break\n    a = f()\n')
  })

  it('un continue en el else, que se crea', () => {
    const text = act('for i in r:\n    if i:\n        a = f()\n', (p) => ({
      type: 'add',
      template: 'continue',
      into: at(p, 2).id,
      branch: 'no',
    }))
    expect(text).toBe('for i in r:\n    if i:\n        a = f()\n    else:\n        continue\n')
  })

  it('al principio de lo que actúa en un bucle, tras sus inicializaciones', () => {
    const text = act('for i in r:\n    n = 0\n    a = f(i)\n', (p) => ({
      type: 'add',
      template: 'print',
      into: at(p, 1).id,
      start: true,
    }))
    expect(text).toBe('for i in r:\n    n = 0\n    print("Hola")\n    a = f(i)\n')
  })

  it('detrás de un nodo, como siempre', () => {
    const text = act('a = f()\nb = g()\n', (p) => ({
      type: 'add',
      template: 'break',
      after: at(p, 1).id,
    }))
    expect(text).toBe('a = f()\nbreak\nb = g()\n')
  })

  it('un sitio que no existe no escribe nada', () => {
    const source = 'a = f()\n'
    expect(
      act(source, (p) => ({
        type: 'add',
        template: 'print',
        into: at(p, 1).id,
        branch: 'yes',
      })),
    ).toBe(source)
  })
})

describe('las constantes calculadas cuentan como inicializaciones', () => {
  it('al principio de lo que actúa va tras una operación entre literales', () => {
    const text = act('def f():\n    n = 0\n    t = 2 * 3\n    a = g()\nx = k()\n', (p) => ({
      type: 'move',
      id: at(p, 5).id,
      into: at(p, 1).id,
      start: true,
    }))
    expect(text).toBe('def f():\n    n = 0\n    t = 2 * 3\n    x = k()\n    a = g()\n')
  })

  it('pero una operación con una variable ya actúa', () => {
    const text = act('def f(p):\n    n = 0\n    t = p * 3\n    a = g()\nx = k()\n', (p) => ({
      type: 'move',
      id: at(p, 5).id,
      into: at(p, 1).id,
      start: true,
    }))
    expect(text).toBe('def f(p):\n    n = 0\n    x = k()\n    t = p * 3\n    a = g()\n')
  })
})
