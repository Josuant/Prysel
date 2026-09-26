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

describe('los caminos de un elif, y el else de un bucle', () => {
  const ELIF = 'if a:\n    x = 1\nelif b:\n    y = 2\nelse:\n    w = 4\nz = h()\n'

  it('un elif es una decisión propia, con su condición, en el camino falso de la anterior', () => {
    const program = parse(ELIF)
    const elif = at(program, 3)
    expect(elif.kind).toBe('control.condition')
    // Una comparación tiene su editor, como la de un if (un nombre suelto, como `b`, no).
    const compared = at(parse('if a > 1:\n    x = 1\nelif b > 2:\n    y = 2\n'), 3)
    expect(compared.control).toMatchObject({
      kind: 'condition',
      field: 'b',
      operator: '>',
      value: '2',
    })
    expect(at(program, 1).continues).toBe(elif.id)
    expect(
      program.edges.some(
        (e) => e.from === at(program, 1).id && e.to === elif.id && e.label === 'falso',
      ),
    ).toBe(true)
    // El else final es el camino falso del elif, no del if.
    expect(
      program.edges.some(
        (e) => e.from === elif.id && e.to === at(program, 6).id && e.label === 'falso',
      ),
    ).toBe(true)
  })

  it('al principio del camino verdadero de un elif', () => {
    const text = act(ELIF, (p) => ({
      type: 'move',
      id: at(p, 7).id,
      into: at(p, 3).id,
      branch: 'yes',
    }))
    expect(text).toBe('if a:\n    x = 1\nelif b:\n    z = h()\n    y = 2\nelse:\n    w = 4\n')
  })

  it('al principio del else, por el camino falso del último elif', () => {
    const text = act(ELIF, (p) => ({
      type: 'move',
      id: at(p, 7).id,
      into: at(p, 3).id,
      branch: 'no',
    }))
    expect(text).toBe('if a:\n    x = 1\nelif b:\n    y = 2\nelse:\n    z = h()\n    w = 4\n')
  })

  it('el camino falso de un if que sigue en un elif no salta al else: se entra por el elif', () => {
    const program = parse(ELIF)
    expect(
      actionEdits(program, {
        type: 'move',
        id: at(program, 7).id,
        into: at(program, 1).id,
        branch: 'no',
      }).edits,
    ).toEqual([])
  })

  it('un último elif sin else lo crea', () => {
    const text = act('if a:\n    x = 1\nelif b:\n    y = 2\nz = h()\n', (p) => ({
      type: 'move',
      id: at(p, 5).id,
      into: at(p, 3).id,
      branch: 'no',
    }))
    expect(text).toBe('if a:\n    x = 1\nelif b:\n    y = 2\nelse:\n    z = h()\n')
  })

  const LOOP_ELSE =
    'for i in r:\n    if i:\n        break\nelse:\n    print("sin salir")\nz = h()\n'

  it('el else de un bucle ya no se pierde: es una cláusula detrás del bucle, con su cuerpo', () => {
    const program = parse(LOOP_ELSE)
    const clause = at(program, 4)
    expect(clause.kind).toBe('control.clause')
    expect(clause.label).toBe('al acabar sin salir')
    expect(clause.contains).toEqual([at(program, 5).id])
    // Va detrás del bucle, en su mismo bloque: no dentro del territorio que se repite.
    expect(at(program, 1).contains).not.toContain(clause.id)
    expect(clause.range?.owner).toBeUndefined()
    // El orden: bucle → su else → lo que sigue.
    const seq = program.edges.filter((e) => e.relation === 'sequence')
    expect(seq.some((e) => e.from === at(program, 1).id && e.to === clause.id)).toBe(true)
    expect(seq.some((e) => e.from === clause.id && e.to === at(program, 6).id)).toBe(true)
  })

  it('al principio del else de un bucle, por su camino falso', () => {
    const text = act(LOOP_ELSE, (p) => ({
      type: 'move',
      id: at(p, 6).id,
      into: at(p, 1).id,
      branch: 'no',
    }))
    expect(text).toBe(
      'for i in r:\n    if i:\n        break\nelse:\n    z = h()\n    print("sin salir")\n',
    )
  })

  it('un bucle sin else lo crea', () => {
    const text = act('while n > 0:\n    n -= 1\nz = h()\n', (p) => ({
      type: 'move',
      id: at(p, 3).id,
      into: at(p, 1).id,
      branch: 'no',
    }))
    expect(text).toBe('while n > 0:\n    n -= 1\nelse:\n    z = h()\n')
  })
})
