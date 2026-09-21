import { createRequire } from 'node:module'
import path from 'node:path'
import type { NodeAction } from '@prysel/morphology'
import { beforeAll, describe, expect, it } from 'vitest'
import { actionEdits, applyEdits } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

/**
 * Conectar es escribir: arrastrar un cable de una salida a un campo pone en ese campo el nombre
 * que la salida define. Aquí se prueba que el analizador dice de dónde salen y adónde llegan los
 * cables, y que conectar solo escribe nombres que Python conoce en ese punto.
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

describe('lo que un nodo ofrece y lo que acepta', () => {
  it('una variable ofrece su nombre', () => {
    const program = parse('total = 5\nx = 1\n')
    expect(find(program, 'total').provides).toBe('total')
  })

  it('un import ofrece lo que deja definido, un bucle su variable, una función su nombre', () => {
    const program = parse(
      'import numpy as np\nfor fila in datos:\n    pass\ndef suma(a):\n    pass\n',
    )
    expect(find(program, 'np').provides).toBe('np')
    expect(program.nodes.find((n) => n.kind === 'control.loop')?.provides).toBe('fila')
    expect(find(program, 'suma').provides).toBe('suma')
  })

  it('una función ofrece además cada parámetro, como un puerto propio', () => {
    const program = parse('def suma(a, b=2):\n    return a + b\n')
    expect(find(program, 'suma').params).toEqual(['a', 'b'])
  })

  it('un parámetro anotado también es un puerto', () => {
    const program = parse('def suma(a: int, b: int = 2):\n    return a + b\n')
    expect(find(program, 'suma').params).toEqual(['a', 'b'])
  })

  it('los operandos de una operación aceptan un cable; el operador no', () => {
    const program = parse('a = 1\nb = 2\nc = a + b\n')
    expect(Object.keys(at(program, 3).inputs ?? {})).toEqual(['left', 'right'])
  })

  it('cada argumento de una llamada es un puerto con su nombre', () => {
    const program = parse('def suma(a, b):\n    return a + b\nx = suma(1, 2)\n')
    expect(Object.keys(at(program, 3).inputs ?? {})).toEqual(['arg:a', 'arg:b'])
  })

  it('la secuencia de un bucle y el valor de una condición aceptan un cable', () => {
    const program = parse('n = 3\nfor i in range(n):\n    pass\nif n > 1:\n    pass\n')
    expect(Object.keys(at(program, 2).inputs ?? {})).toEqual(['iterable'])
    expect(Object.keys(at(program, 4).inputs ?? {})).toEqual(['field', 'value'])
  })

  it('el mensaje de un print acepta un cable, y sustituye la cadena entera', () => {
    const program = parse('print("Hola")\n')
    const message = at(program, 1).inputs?.['value']
    expect(program.source.slice(message?.start, message?.end)).toBe('"Hola"')
  })

  it('un valor literal no acepta cables', () => {
    const program = parse('a = 5\nb = "hola"\n')
    expect(at(program, 1).inputs).toBeUndefined()
    expect(at(program, 2).inputs).toBeUndefined()
  })

  it('cada nodo sabe qué nombres puede leer: lo definido antes, en su ámbito', () => {
    const program = parse('a = 1\ndef f(p):\n    x = p\n    y = x\nz = 3\n')
    expect(at(program, 4).scope).toEqual(['a', 'f', 'p', 'x'])
    // Lo local de `f` no se ve fuera de ella.
    expect(at(program, 5).scope).toEqual(['a', 'f'])
  })
})

describe('los cables que salen de un parámetro', () => {
  it('lo que lee un parámetro dentro de la función sale por el puerto de ese parámetro', () => {
    const program = parse('def suma(a, b):\n    return a + b\n')
    const def = find(program, 'suma')
    const edges = program.edges.filter((e) => e.from === def.id)
    expect(edges.map((e) => [e.fromPort, e.toPort])).toEqual([
      ['param:a', 'left'],
      ['param:b', 'right'],
    ])
  })

  it('un valor que no es un parámetro sale por el puerto normal', () => {
    const program = parse('a = 1\nb = a + 1\n')
    const edge = program.edges.find((e) => e.from === at(program, 1).id)
    expect(edge?.fromPort).toBeUndefined()
  })
})

describe('conectar escribe el nombre en el campo', () => {
  it('una variable a un operando', () => {
    const { text } = act('a = 1\nb = 2\nc = 0 + 0\n', (p) => ({
      type: 'connect',
      from: find(p, 'a').id,
      to: find(p, 'c').id,
      slot: 'left',
    }))
    expect(text).toBe('a = 1\nb = 2\nc = a + 0\n')
  })

  it('sustituye lo que hubiera, aunque sea una expresión', () => {
    const { text } = act('a = 1\nb = 2\nc = (a * 3) + b\n', (p) => ({
      type: 'connect',
      from: find(p, 'b').id,
      to: find(p, 'c').id,
      slot: 'left',
    }))
    expect(text).toBe('a = 1\nb = 2\nc = b + b\n')
  })

  it('a un argumento de una llamada', () => {
    const { text, program } = act(
      'def suma(a, b):\n    return a + b\nx = 1\ny = suma(0, 0)\n',
      (p) => ({ type: 'connect', from: find(p, 'x').id, to: find(p, 'y').id, slot: 'arg:b' }),
    )
    expect(text).toBe('def suma(a, b):\n    return a + b\nx = 1\ny = suma(0, x)\n')
    // Y el cable existe en el programa reanalizado.
    expect(
      program.edges.some((e) => e.toPort === 'arg:b' && e.from === find(program, 'x').id),
    ).toBe(true)
  })

  it('al mensaje de un print, que pasa de cadena a variable', () => {
    const { text } = act('nombre = "Ana"\nprint("Hola")\n', (p) => ({
      type: 'connect',
      from: find(p, 'nombre').id,
      to: at(p, 2).id,
      slot: 'value',
    }))
    expect(text).toBe('nombre = "Ana"\nprint(nombre)\n')
  })

  it('a la secuencia de un bucle', () => {
    const { text } = act('datos = [1, 2]\nfor x in range(3):\n    pass\n', (p) => ({
      type: 'connect',
      from: find(p, 'datos').id,
      to: at(p, 2).id,
      slot: 'iterable',
    }))
    expect(text).toBe('datos = [1, 2]\nfor x in datos:\n    pass\n')
  })

  it('desde un parámetro, hacia lo que hay dentro de la función', () => {
    const { text } = act('def f(a, b):\n    c = 0 + 0\n', (p) => ({
      type: 'connect',
      from: find(p, 'f').id,
      port: 'param:b',
      to: find(p, 'c').id,
      slot: 'right',
    }))
    expect(text).toBe('def f(a, b):\n    c = 0 + b\n')
  })

  it('la variable de un bucle, hacia lo que hay dentro de él', () => {
    const { text } = act('for i in range(3):\n    c = 0 + 0\n', (p) => ({
      type: 'connect',
      from: p.nodes.find((n) => n.kind === 'control.loop')?.id ?? '',
      to: find(p, 'c').id,
      slot: 'left',
    }))
    expect(text).toBe('for i in range(3):\n    c = i + 0\n')
  })

  it('el resultado sigue siendo Python válido', () => {
    const { text } = act('a = 1\nc = 0 + 0\nprint("x")\n', (p) => ({
      type: 'connect',
      from: find(p, 'a').id,
      to: find(p, 'c').id,
      slot: 'right',
    }))
    expect(valid(text)).toBe(true)
  })
})

describe('conectar no escribe lo que Python no conocería', () => {
  const none = (source: string, make: (p: Program) => NodeAction) =>
    expect(act(source, make).change.edits).toEqual([])

  it('un valor definido después del nodo', () => {
    none('c = 0 + 0\na = 1\n', (p) => ({
      type: 'connect',
      from: find(p, 'a').id,
      to: find(p, 'c').id,
      slot: 'left',
    }))
  })

  it('una variable local de otra función', () => {
    none('def f():\n    x = 1\ndef g():\n    c = 0 + 0\n', (p) => ({
      type: 'connect',
      from: find(p, 'x').id,
      to: find(p, 'c').id,
      slot: 'left',
    }))
  })

  it('un parámetro hacia fuera de su función', () => {
    none('def f(a):\n    pass\nc = 0 + 0\n', (p) => ({
      type: 'connect',
      from: find(p, 'f').id,
      port: 'param:a',
      to: find(p, 'c').id,
      slot: 'left',
    }))
  })

  it('un nodo consigo mismo', () => {
    none('a = 0 + 0\n', (p) => ({
      type: 'connect',
      from: find(p, 'a').id,
      to: find(p, 'a').id,
      slot: 'left',
    }))
  })

  it('a un campo que no acepta cables (un literal, un operador)', () => {
    none('a = 1\nb = 5\n', (p) => ({
      type: 'connect',
      from: find(p, 'a').id,
      to: find(p, 'b').id,
      slot: 'value',
    }))
    none('a = 1\nc = 1 + 2\n', (p) => ({
      type: 'connect',
      from: find(p, 'a').id,
      to: find(p, 'c').id,
      slot: 'operator',
    }))
  })

  it('un origen que no define nada (un print)', () => {
    none('print("x")\nc = 0 + 0\n', (p) => ({
      type: 'connect',
      from: at(p, 1).id,
      to: find(p, 'c').id,
      slot: 'left',
    }))
  })

  it('el mismo nombre que ya hay: no hay nada que cambiar', () => {
    none('a = 1\nc = a + 0\n', (p) => ({
      type: 'connect',
      from: find(p, 'a').id,
      to: find(p, 'c').id,
      slot: 'left',
    }))
  })
})

describe('desconectar deja un valor neutro', () => {
  it('un operando vuelve a 0', () => {
    const { text } = act('a = 1\nc = a + 2\n', (p) => ({
      type: 'disconnect',
      id: find(p, 'c').id,
      slot: 'left',
    }))
    expect(text).toBe('a = 1\nc = 0 + 2\n')
  })

  it('un argumento vuelve a None, y una secuencia a una lista vacía', () => {
    expect(
      act('x = 1\ny = f(x)\n', (p) => ({
        type: 'disconnect',
        id: find(p, 'y').id,
        slot: 'arg:valor',
      })).text,
    ).toBe('x = 1\ny = f(None)\n')
    expect(
      act('d = [1]\nfor i in d:\n    pass\n', (p) => ({
        type: 'disconnect',
        id: at(p, 2).id,
        slot: 'iterable',
      })).text,
    ).toBe('d = [1]\nfor i in []:\n    pass\n')
  })

  it('un print que imprimía una variable pasa a imprimir None', () => {
    const { text } = act('n = "a"\nprint(n)\n', (p) => ({
      type: 'disconnect',
      id: at(p, 2).id,
      slot: 'arg:mensaje',
    }))
    expect(text).toBe('n = "a"\nprint(None)\n')
  })

  it('un campo sin cable no cambia nada', () => {
    const { change } = act('a = 1\n', (p) => ({
      type: 'disconnect',
      id: find(p, 'a').id,
      slot: 'left',
    }))
    expect(change.edits).toEqual([])
  })
})

describe('soltar un cable en el vacío crea el nodo ya conectado', () => {
  it('una operación que lee la variable', () => {
    const { text } = act('a = 1\n', (p) => ({
      type: 'add',
      template: 'operation',
      after: find(p, 'a').id,
      connect: { from: find(p, 'a').id },
    }))
    expect(text).toBe('a = 1\nresultado = a + 2\n')
  })

  it('un print que la imprime', () => {
    const { text } = act('a = 1\n', (p) => ({
      type: 'add',
      template: 'print',
      after: find(p, 'a').id,
      connect: { from: find(p, 'a').id },
    }))
    expect(text).toBe('a = 1\nprint(a)\n')
  })

  it('un bucle que la recorre', () => {
    const { text } = act('a = [1]\n', (p) => ({
      type: 'add',
      template: 'for',
      after: find(p, 'a').id,
      connect: { from: find(p, 'a').id },
    }))
    expect(text).toBe('a = [1]\nfor elemento in a:\n    pass\n')
  })

  it('desde un parámetro, dentro de la función', () => {
    const { text } = act('def f(a):\n    x = 1\n', (p) => ({
      type: 'add',
      template: 'print',
      into: find(p, 'f').id,
      connect: { from: find(p, 'f').id, port: 'param:a' },
    }))
    expect(text).toBe('def f(a):\n    x = 1\n    print(a)\n')
  })

  it('un origen que no define nada no rellena nada: la plantilla sale como siempre', () => {
    const { text } = act('print("x")\n', (p) => ({
      type: 'add',
      template: 'print',
      after: at(p, 1).id,
      connect: { from: at(p, 1).id },
    }))
    expect(text).toBe('print("x")\nprint("Hola")\n')
  })
})

describe('meter un nodo dentro de una función vacía', () => {
  it('sustituye el pass en vez de dejarlo colgando', () => {
    const { text, change } = act('def f(a):\n    pass\n', (p) => ({
      type: 'add',
      template: 'print',
      into: find(p, 'f').id,
      connect: { from: find(p, 'f').id, port: 'param:a' },
    }))
    expect(text).toBe('def f(a):\n    print(a)\n')
    expect(change.select?.line).toBe(2)
    expect(valid(text)).toBe(true)
  })

  it('con varias líneas, todas van con la sangría del cuerpo', () => {
    const { text } = act('def f():\n    pass\n', (p) => ({
      type: 'add',
      template: 'if',
      into: find(p, 'f').id,
    }))
    expect(text).toBe('def f():\n    if valor > 0:\n        pass\n')
  })

  it('un cuerpo que no era solo pass conserva lo que tenía', () => {
    const { text } = act('def f():\n    x = 1\n', (p) => ({
      type: 'add',
      template: 'print',
      into: find(p, 'f').id,
    }))
    expect(text).toBe('def f():\n    x = 1\n    print("Hola")\n')
  })

  it('el cuerpo de un bucle también', () => {
    const { text } = act('for i in range(2):\n    pass\n', (p) => ({
      type: 'add',
      template: 'print',
      into: p.nodes.find((n) => n.kind === 'control.loop')?.id ?? '',
      connect: { from: p.nodes.find((n) => n.kind === 'control.loop')?.id ?? '' },
    }))
    expect(text).toBe('for i in range(2):\n    print(i)\n')
  })
})
