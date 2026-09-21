import { createRequire } from 'node:module'
import path from 'node:path'
import type { NodeAction } from '@prysel/morphology'
import { beforeAll, describe, expect, it } from 'vitest'
import { actionEdits, applyEdits } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

/**
 * Elegir a quién llama una llamada (con el desplegable o soltando el chip de una función): la
 * lista de argumentos se ajusta a los parámetros de la función, y un resultado se guarda.
 * También, añadir una variable al principio de un contexto: es donde se inicializan.
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

function act(source: string, make: (program: Program) => NodeAction) {
  const program = parse(source)
  const change = actionEdits(program, make(program))
  return {
    text: applyEdits(source, change.edits),
    change,
    program: parse(applyEdits(source, change.edits)),
  }
}

const FUNCTIONS = [
  'def sumar(a, b):',
  '    return a + b',
  '',
  'def elevar(base, exponente, modulo):',
  '    return base ** exponente',
  '',
  'def ruido():',
  '    print("x")',
  '',
].join('\n')

describe('una llamada expone a quién llama y sus argumentos', () => {
  it('a quién llama es una casilla que acepta una función', () => {
    const program = parse(`${FUNCTIONS}r = sumar(1, 2)\n`)
    expect(Object.keys(find(program, 'r').inputs ?? {})).toContain('callee')
  })

  it('una llamada sin argumentos a una función suelta también tiene editor', () => {
    const program = parse(`${FUNCTIONS}ruido()\n`)
    const call = program.nodes.find((n) => n.line === 9)
    expect(call?.control).toMatchObject({ kind: 'args', target: 'ruido', args: [] })
  })

  it('print no lo tiene sin argumentos: no hay nada que elegir', () => {
    expect(parse('print()\n').nodes[0]?.control).toBeUndefined()
  })
})

describe('cambiar a quién llama', () => {
  it('ajusta los argumentos a los parámetros de la nueva función', () => {
    const { text } = act(`${FUNCTIONS}r = sumar(1, 2)\n`, (p) => ({
      type: 'callee',
      id: find(p, 'r').id,
      callee: 'elevar',
    }))
    // Los valores que había se conservan por posición; el que falta queda en None.
    expect(text.split('\n').at(-2)).toBe('r = elevar(1, 2, None)')
  })

  it('con menos parámetros, sobran los últimos', () => {
    const { text } = act(`${FUNCTIONS}r = elevar(1, 2, 3)\n`, (p) => ({
      type: 'callee',
      id: find(p, 'r').id,
      callee: 'sumar',
    }))
    expect(text.split('\n').at(-2)).toBe('r = sumar(1, 2)')
  })

  it('una función de uso común (print, len…) cambia el nombre y deja los argumentos', () => {
    const { text } = act('r = float(x)\n', (p) => ({
      type: 'callee',
      id: find(p, 'r').id,
      callee: 'int',
    }))
    expect(text).toBe('r = int(x)\n')
  })

  it('una llamada suelta a una función que devuelve algo guarda su resultado', () => {
    const { text } = act(`${FUNCTIONS}ruido()\n`, (p) => ({
      type: 'callee',
      id: p.nodes.find((n) => n.line === 9)?.id ?? '',
      callee: 'sumar',
    }))
    expect(text.split('\n').at(-2)).toBe('resultado = sumar(None, None)')
  })

  it('el nombre del resultado no choca con uno que ya existe', () => {
    const { text } = act(`${FUNCTIONS}resultado = 1\nruido()\n`, (p) => ({
      type: 'callee',
      id: p.nodes.find((n) => n.line === 10)?.id ?? '',
      callee: 'sumar',
    }))
    expect(text.split('\n').at(-2)).toBe('resultado_2 = sumar(None, None)')
  })

  it('una función que no devuelve nada no crea una variable', () => {
    const { text } = act(`${FUNCTIONS}sumar(1, 2)\n`, (p) => ({
      type: 'callee',
      id: p.nodes.find((n) => n.line === 9)?.id ?? '',
      callee: 'ruido',
    }))
    expect(text.split('\n').at(-2)).toBe('ruido()')
  })

  it('un nombre que no se puede llamar se rechaza', () => {
    const { change } = act(`${FUNCTIONS}r = sumar(1, 2)\n`, (p) => ({
      type: 'callee',
      id: find(p, 'r').id,
      callee: '1 + 2',
    }))
    expect(change.edits).toEqual([])
  })

  it('el mismo nombre no cambia nada', () => {
    const { change } = act(`${FUNCTIONS}r = sumar(1, 2)\n`, (p) => ({
      type: 'callee',
      id: find(p, 'r').id,
      callee: 'sumar',
    }))
    expect(change.edits).toEqual([])
  })

  it('el resultado sigue siendo Python válido y cada parámetro tiene su casilla', () => {
    const { program } = act(`${FUNCTIONS}r = sumar(1, 2)\n`, (p) => ({
      type: 'callee',
      id: find(p, 'r').id,
      callee: 'elevar',
    }))
    expect(Object.keys(find(program, 'r').inputs ?? {})).toEqual([
      'callee',
      'arg:base',
      'arg:exponente',
      'arg:modulo',
    ])
  })
})

describe('soltar el chip de una función sobre una llamada', () => {
  it('es lo mismo que elegirla', () => {
    const { text } = act(`${FUNCTIONS}r = sumar(1, 2)\n`, (p) => ({
      type: 'connect',
      from: find(p, 'elevar').id,
      to: find(p, 'r').id,
      slot: 'callee',
    }))
    expect(text.split('\n').at(-2)).toBe('r = elevar(1, 2, None)')
  })

  it('no se llama a algo que no es una función', () => {
    const { change } = act(`${FUNCTIONS}x = 5\nr = sumar(1, 2)\n`, (p) => ({
      type: 'connect',
      from: find(p, 'x').id,
      to: find(p, 'r').id,
      slot: 'callee',
    }))
    expect(change.edits).toEqual([])
  })
})

describe('añadir una variable al principio de un contexto', () => {
  it('en el archivo: antes de la primera sentencia, después de los import', () => {
    const { text } = act('import os\nx = 1\nprint(x)\n', () => ({
      type: 'add',
      template: 'variable',
      at: 'start',
    }))
    expect(text).toBe('import os\nvariable = 0\nx = 1\nprint(x)\n')
  })

  it('en el archivo, si empieza por código, va la primera', () => {
    const { text } = act('print("hola")\n', () => ({
      type: 'add',
      template: 'variable',
      at: 'start',
    }))
    expect(text).toBe('variable = 0\nprint("hola")\n')
  })

  it('en una función: antes de su primera sentencia, con su sangría', () => {
    const { text } = act('def f(a):\n    s = a\n    return s\n', (p) => ({
      type: 'add',
      template: 'variable',
      at: 'start',
      into: find(p, 'f').id,
    }))
    expect(text).toBe('def f(a):\n    variable = 0\n    s = a\n    return s\n')
  })

  it('en un bucle', () => {
    const { text } = act('for i in r:\n    print(i)\n', (p) => ({
      type: 'add',
      template: 'variable',
      at: 'start',
      into: p.nodes.find((n) => n.kind === 'control.loop')?.id ?? '',
    }))
    expect(text).toBe('for i in r:\n    variable = 0\n    print(i)\n')
  })

  it('en un contexto vacío (pass) sustituye el pass', () => {
    const { text } = act('def f():\n    pass\n', (p) => ({
      type: 'add',
      template: 'variable',
      at: 'start',
      into: find(p, 'f').id,
    }))
    expect(text).toBe('def f():\n    variable = 0\n')
  })

  it('queda seleccionada donde se escribió', () => {
    const { change, program } = act('def f(a):\n    s = a\n', (p) => ({
      type: 'add',
      template: 'variable',
      at: 'start',
      into: find(p, 'f').id,
    }))
    expect(program.nodes.find((n) => n.line === change.select?.line)?.label).toBe('variable')
  })
})

describe('convertir al conectar', () => {
  it('un texto que llega a un campo numérico se escribe con float()', () => {
    const { text } = act('n = input("x")\nr = 0 - 0\n', (p) => ({
      type: 'connect',
      from: find(p, 'n').id,
      to: find(p, 'r').id,
      slot: 'right',
      convert: 'float',
    }))
    expect(text).toBe('n = input("x")\nr = 0 - float(n)\n')
  })

  it('sin conversión escribe el nombre a secas', () => {
    const { text } = act('n = 1\nr = 0 - 0\n', (p) => ({
      type: 'connect',
      from: find(p, 'n').id,
      to: find(p, 'r').id,
      slot: 'right',
    }))
    expect(text).toBe('n = 1\nr = 0 - n\n')
  })
})

describe('subir un valor a las inicializaciones del contexto', () => {
  it('antes de la primera sentencia del programa', () => {
    const { text } = act('print("a")\nx = 5\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      before: p.nodes[0]?.id ?? '',
    }))
    expect(text).toBe('x = 5\nprint("a")\n')
  })

  it('en una función, con su sangría', () => {
    const { text } = act('def f(a):\n    s = a\n    limite = 3\n    return s\n', (p) => ({
      type: 'move',
      id: find(p, 'limite').id,
      before: find(p, 's').id,
    }))
    expect(text).toBe('def f(a):\n    limite = 3\n    s = a\n    return s\n')
  })

  it('se lleva los comentarios pegados encima', () => {
    const { text } = act('print("a")\n# el tope\nx = 5\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      before: p.nodes[0]?.id ?? '',
    }))
    expect(text).toBe('# el tope\nx = 5\nprint("a")\n')
  })

  it('no se mueve delante de sí mismo', () => {
    const { change } = act('x = 5\n', (p) => ({
      type: 'move',
      id: find(p, 'x').id,
      before: find(p, 'x').id,
    }))
    expect(change.edits).toEqual([])
  })
})
