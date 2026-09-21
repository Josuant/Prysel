import { createRequire } from 'node:module'
import path from 'node:path'
import type { ControlModel, NodeAction } from '@prysel/morphology'
import { beforeAll, describe, expect, it } from 'vitest'
import { actionEdits, applyEdits, editsFor, isIdentifier } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

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

/** Aplica una acción sobre un texto, y devuelve el texto nuevo, el programa reanalizado y dónde quedó lo creado. */
function act(source: string, make: (program: Program) => NodeAction) {
  const program = parse(source)
  const change = actionEdits(program, make(program))
  const text = applyEdits(source, change.edits)
  return { text, program: parse(text), change }
}

/** ¿Hay un error de sintaxis en lo que se acaba de escribir? El analizador es tolerante: se mira el árbol. */
const valid = (text: string) => !parser.parse(text).rootNode.hasError

describe('renombrar cambia el nombre en todos los sitios donde se usa', () => {
  it('una variable, su definición y todos sus usos', () => {
    const { text } = act('total = 5\nb = total + 1\nprint(total)\n', (p) => ({
      type: 'rename',
      id: find(p, 'total').id,
      to: 'suma',
    }))
    expect(text).toBe('suma = 5\nb = suma + 1\nprint(suma)\n')
  })

  it('no toca lo que se llama igual pero es otra cosa (un atributo, un argumento con nombre)', () => {
    const { text } = act('total = 1\nx = obj.total\ny = f(total=total)\n', (p) => ({
      type: 'rename',
      id: find(p, 'total').id,
      to: 'suma',
    }))
    expect(text).toBe('suma = 1\nx = obj.total\ny = f(total=suma)\n')
  })

  it('no toca la variable local de una comprensión que se llama igual', () => {
    const { text } = act('x = 10\nlista = [x for x in range(3)]\nz = x + 1\n', (p) => ({
      type: 'rename',
      id: find(p, 'x').id,
      to: 'base',
    }))
    expect(text).toBe('base = 10\nlista = [x for x in range(3)]\nz = base + 1\n')
  })

  it('un nombre repetido en una misma expresión se cambia en todas', () => {
    const { text } = act('a = 2\nb = a * a + a\n', (p) => ({
      type: 'rename',
      id: find(p, 'a').id,
      to: 'k',
    }))
    expect(text).toBe('k = 2\nb = k * k + k\n')
  })

  it('un uso dentro de un f-string', () => {
    const { text } = act('nombre = "Ana"\nprint(f"Hola {nombre}")\n', (p) => ({
      type: 'rename',
      id: find(p, 'nombre').id,
      to: 'quien',
    }))
    expect(text).toBe('quien = "Ana"\nprint(f"Hola {quien}")\n')
  })

  it('una función, con sus llamadas', () => {
    const { text } = act(
      'def suma(a, b):\n    return a + b\nr = suma(1, 2)\ns = suma(3, 4)\n',
      (p) => ({
        type: 'rename',
        id: find(p, 'suma').id,
        to: 'sumar',
      }),
    )
    expect(text).toBe('def sumar(a, b):\n    return a + b\nr = sumar(1, 2)\ns = sumar(3, 4)\n')
  })

  it('una reasignación es otro nodo: cambiar el primero no cambia el segundo', () => {
    const { text } = act('x = 1\ny = x\nx = 5\nz = x\n', (p) => ({
      type: 'rename',
      id: p.nodes.find((n) => n.label === 'x')?.id ?? '',
      to: 'a',
    }))
    expect(text).toBe('a = 1\ny = a\nx = 5\nz = x\n')
  })

  it('un parámetro, con sus usos dentro de la función', () => {
    const program = parse('def f(a, b):\n    return a + b\n')
    const fn = find(program, 'f')
    const change = editsFor(fn, {
      kind: 'signature',
      params: [
        { name: 'primero', value: '' },
        { name: 'b', value: '' },
      ],
    })
    expect(applyEdits(program.source, change)).toBe('def f(primero, b):\n    return primero + b\n')
  })

  it('la variable de un bucle, con sus usos en el cuerpo', () => {
    const program = parse('for n in range(3):\n    print(n)\n')
    const loop = program.nodes.find((n) => n.kind === 'control.loop')
    if (!loop?.control || loop.control.kind !== 'loop') throw new Error('sin bucle')
    const text = applyEdits(program.source, editsFor(loop, { ...loop.control, variable: 'i' }))
    expect(text).toBe('for i in range(3):\n    print(i)\n')
  })

  it('el alias de un import, con sus usos', () => {
    const program = parse('import pandas as pd\ndf = pd.read_csv("a.csv")\n')
    const node = program.nodes.find((n) => n.kind === 'external.import')
    if (!node?.control || node.control.kind !== 'module') throw new Error('sin import')
    const text = applyEdits(program.source, editsFor(node, { ...node.control, alias: 'pandas_' }))
    expect(text).toBe('import pandas as pandas_\ndf = pandas_.read_csv("a.csv")\n')
  })

  it('un valor por defecto lee de fuera, y renombrar lo de fuera lo alcanza', () => {
    const { text } = act('limite = 3\ndef f(a, tope=limite):\n    return a\n', (p) => ({
      type: 'rename',
      id: find(p, 'limite').id,
      to: 'techo',
    }))
    expect(text).toBe('techo = 3\ndef f(a, tope=techo):\n    return a\n')
  })

  it('rechaza un nombre que no es un identificador de Python', () => {
    for (const bad of ['', '1a', 'a b', 'for', 'a-b', 'None']) {
      expect(isIdentifier(bad)).toBe(false)
      const { text } = act('x = 1\n', (p) => ({ type: 'rename', id: find(p, 'x').id, to: bad }))
      expect(text).toBe('x = 1\n')
    }
    expect(isIdentifier('ñandú_2')).toBe(true)
  })
})

describe('escribir cualquier nodo como código', () => {
  it('reescribe una sentencia entera', () => {
    const { text } = act('a = 1\nb = a + 2\n', (p) => ({
      type: 'code',
      id: find(p, 'b').id,
      text: 'b = sorted(a, reverse=True)[0]',
    }))
    expect(text).toBe('a = 1\nb = sorted(a, reverse=True)[0]\n')
  })

  it('de una sentencia compuesta reescribe solo la cabecera y conserva el cuerpo', () => {
    const { text } = act('if a < 0:\n    x = 1\nelse:\n    x = 2\n', (p) => ({
      type: 'code',
      id: p.nodes.find((n) => n.kind === 'control.condition')?.id ?? '',
      text: 'if a < 0 and b > 5:',
    }))
    expect(text).toBe('if a < 0 and b > 5:\n    x = 1\nelse:\n    x = 2\n')
  })

  it('la cabecera de una función, con su cuerpo intacto', () => {
    const { text } = act('def f(a):\n    return a\n', (p) => ({
      type: 'code',
      id: find(p, 'f').id,
      text: 'def f(a, *rest, **kw):',
    }))
    expect(text).toBe('def f(a, *rest, **kw):\n    return a\n')
  })

  it('conserva el comentario en línea que había detrás', () => {
    const { text } = act('x = 5  # el tope\n', (p) => ({
      type: 'code',
      id: find(p, 'x').id,
      text: 'x = 50',
    }))
    expect(text).toBe('x = 50  # el tope\n')
  })

  it('lo que no tenía editor (un with, un try) también se puede escribir, entero', () => {
    const source = 'with open("a") as f:\n    data = f.read()\n'
    const program = parse(source)
    const node = program.nodes[0]
    // Una construcción opaca no tiene cuerpo dibujado: su texto editable es la sentencia entera.
    expect(node?.text).toBe('with open("a") as f:\n    data = f.read()')
    const { text } = act(source, (p) => ({
      type: 'code',
      id: p.nodes[0]?.id ?? '',
      text: 'with open("b") as f:\n    data = f.read().strip()',
    }))
    expect(text).toBe('with open("b") as f:\n    data = f.read().strip()\n')
    expect(valid(text)).toBe(true)
  })

  it('un texto igual al que había no genera ninguna edición', () => {
    const program = parse('x = 5\n')
    expect(
      actionEdits(program, { type: 'code', id: find(program, 'x').id, text: 'x = 5' }).edits,
    ).toEqual([])
  })
})

describe('eliminar un nodo', () => {
  it('quita la línea entera', () => {
    const { text } = act('a = 1\nb = 2\nc = 3\n', (p) => ({ type: 'delete', id: find(p, 'b').id }))
    expect(text).toBe('a = 1\nc = 3\n')
  })

  it('con su cuerpo, si es compuesta', () => {
    const { text } = act('a = 1\nfor i in xs:\n    print(i)\n    print(2)\nb = 2\n', (p) => ({
      type: 'delete',
      id: p.nodes.find((n) => n.kind === 'control.loop')?.id ?? '',
    }))
    expect(text).toBe('a = 1\nb = 2\n')
  })

  it('una función entera, con todo lo que tiene dentro', () => {
    const { text } = act('def f(a):\n    x = a\n    return x\nprint(1)\n', (p) => ({
      type: 'delete',
      id: find(p, 'f').id,
    }))
    expect(text).toBe('print(1)\n')
  })

  it('se lleva los comentarios pegados encima, pero no un título de sección separado', () => {
    const { text } = act('# --- Sección ---\n\n# calcula b\nb = 2\nc = 3\n', (p) => ({
      type: 'delete',
      id: find(p, 'b').id,
    }))
    expect(text).toBe('# --- Sección ---\n\nc = 3\n')
  })

  it('el comentario en línea desaparece con su línea', () => {
    const { text } = act('a = 1  # uno\nb = 2\n', (p) => ({ type: 'delete', id: find(p, 'a').id }))
    expect(text).toBe('b = 2\n')
  })

  it('lo único de un bloque deja un `pass`: un bloque vacío no es Python válido', () => {
    const { text } = act('if a:\n    x = 1\n', (p) => ({ type: 'delete', id: find(p, 'x').id }))
    expect(text).toBe('if a:\n    pass\n')
    expect(valid(text)).toBe(true)
  })

  it('si quedan otras sentencias en el bloque, no añade nada', () => {
    const { text } = act('if a:\n    x = 1\n    y = 2\n', (p) => ({
      type: 'delete',
      id: find(p, 'x').id,
    }))
    expect(text).toBe('if a:\n    y = 2\n')
  })

  it('lo último de un archivo sin salto de línea final', () => {
    const { text } = act('a = 1\nb = 2', (p) => ({ type: 'delete', id: find(p, 'b').id }))
    expect(text).toBe('a = 1\n')
  })

  it('respeta los saltos de línea CRLF', () => {
    const { text } = act('a = 1\r\nb = 2\r\nc = 3\r\n', (p) => ({
      type: 'delete',
      id: find(p, 'b').id,
    }))
    expect(text).toBe('a = 1\r\nc = 3\r\n')
  })
})

describe('duplicar un nodo', () => {
  it('pone una copia justo debajo, con su misma sangría', () => {
    const { text, change } = act('def f():\n    x = 1\n    y = 2\n', (p) => ({
      type: 'duplicate',
      id: find(p, 'x').id,
    }))
    expect(text).toBe('def f():\n    x = 1\n    x = 1\n    y = 2\n')
    expect(change.select?.line).toBe(3)
  })

  it('de una sentencia compuesta copia también su cuerpo', () => {
    const { text } = act('if a:\n    x = 1\n', (p) => ({
      type: 'duplicate',
      id: p.nodes.find((n) => n.kind === 'control.condition')?.id ?? '',
    }))
    expect(text).toBe('if a:\n    x = 1\nif a:\n    x = 1\n')
    expect(valid(text)).toBe(true)
  })
})

describe('añadir un nodo', () => {
  it('al final del archivo, si no se dice dónde', () => {
    const { text, change } = act('a = 1\n', () => ({ type: 'add', template: 'print' }))
    expect(text).toBe('a = 1\nprint("Hola")\n')
    expect(change.select?.line).toBe(2)
  })

  it('en un archivo vacío', () => {
    const { text } = act('', () => ({ type: 'add', template: 'variable' }))
    expect(text).toBe('variable = 0\n')
  })

  it('en un archivo que no acaba en salto de línea', () => {
    const { text } = act('a = 1', () => ({ type: 'add', template: 'print' }))
    expect(text).toBe('a = 1\nprint("Hola")\n')
  })

  it('detrás de un nodo, con su sangría', () => {
    const { text, change } = act('def f():\n    x = 1\n    y = 2\n', (p) => ({
      type: 'add',
      template: 'print',
      after: find(p, 'x').id,
    }))
    expect(text).toBe('def f():\n    x = 1\n    print("Hola")\n    y = 2\n')
    expect(change.select?.line).toBe(3)
  })

  it('detrás de una sentencia compuesta va tras todo su cuerpo, no dentro', () => {
    const { text } = act('if a:\n    x = 1\ny = 2\n', (p) => ({
      type: 'add',
      template: 'print',
      after: p.nodes.find((n) => n.kind === 'control.condition')?.id ?? '',
    }))
    expect(text).toBe('if a:\n    x = 1\nprint("Hola")\ny = 2\n')
  })

  it('al final del cuerpo de una función', () => {
    const { text } = act('def f():\n    x = 1\nprint(0)\n', (p) => ({
      type: 'add',
      template: 'return',
      into: find(p, 'f').id,
    }))
    expect(text).toBe('def f():\n    x = 1\n    return valor\nprint(0)\n')
  })

  it('en una función que solo tiene un `pass`', () => {
    const { text } = act('def f():\n    pass\n', (p) => ({
      type: 'add',
      template: 'variable',
      into: find(p, 'f').id,
    }))
    expect(valid(text)).toBe(true)
    expect(text).toContain('    variable = 0')
  })

  it('una función nueva se separa con dos líneas en blanco', () => {
    const { text } = act('a = 1\n', () => ({ type: 'add', template: 'function' }))
    expect(text).toBe('a = 1\n\n\ndef nueva_funcion(a, b):\n    return a + b\n')
  })

  it('un bloque con varias líneas se sangra entero', () => {
    const { text } = act('def f():\n    x = 1\n', (p) => ({
      type: 'add',
      template: 'ifelse',
      after: find(p, 'x').id,
    }))
    expect(text).toBe(
      'def f():\n    x = 1\n    if valor > 0:\n        pass\n    else:\n        pass\n',
    )
    expect(valid(text)).toBe(true)
  })

  it('cada plantilla produce Python válido y un nodo nuevo', () => {
    for (const template of [
      'variable',
      'text',
      'boolean',
      'list',
      'dict',
      'operation',
      'call',
      'input',
      'print',
      'if',
      'ifelse',
      'for',
      'while',
      'return',
      'raise',
      'import',
      'function',
    ] as const) {
      const before = parse('a = 1\n')
      const { text, program } = act('a = 1\n', () => ({ type: 'add', template }))
      expect(valid(text), template).toBe(true)
      // `pass` no es un nodo, así que un cuerpo vacío no suma ninguno más que el suyo.
      expect(program.nodes.length, template).toBeGreaterThan(before.nodes.length)
    }
  })

  it('lo creado se puede localizar por su línea para enfocarlo', () => {
    const { program, change } = act('a = 1\nb = 2\n', (p) => ({
      type: 'add',
      template: 'print',
      after: find(p, 'a').id,
    }))
    expect(program.nodes.find((n) => n.line === change.select?.line)?.label).toBe('Imprimir')
  })

  it('respeta los saltos de línea CRLF', () => {
    const { text } = act('a = 1\r\nb = 2\r\n', (p) => ({
      type: 'add',
      template: 'print',
      after: find(p, 'a').id,
    }))
    expect(text).toBe('a = 1\r\nprint("Hola")\r\nb = 2\r\n')
  })
})

describe('listas, diccionarios y parámetros', () => {
  const change = (source: string, label: string, next: (c: ControlModel) => ControlModel) => {
    const program = parse(source)
    const node = find(program, label)
    if (!node.control) throw new Error('sin editor')
    return applyEdits(source, editsFor(node, next(node.control)))
  }

  it('añadir y quitar elementos de una lista', () => {
    expect(
      change('xs = [1, 2, 3]\n', 'xs', (c) =>
        c.kind === 'list' ? { ...c, items: [...c.items, '4'] } : c,
      ),
    ).toBe('xs = [1, 2, 3, 4]\n')
    expect(
      change('xs = [1, 2, 3]\n', 'xs', (c) =>
        c.kind === 'list' ? { ...c, items: c.items.slice(1) } : c,
      ),
    ).toBe('xs = [2, 3]\n')
  })

  it('una lista vaciada queda como `[]`', () => {
    expect(
      change('xs = [1, 2]\n', 'xs', (c) => (c.kind === 'list' ? { ...c, items: [] } : c)),
    ).toBe('xs = []\n')
  })

  it('las entradas de un diccionario', () => {
    expect(
      change('d = {"a": 1}\n', 'd', (c) =>
        c.kind === 'dict' ? { ...c, entries: [...c.entries, ['"b"', '2']] } : c,
      ),
    ).toBe('d = {"a": 1, "b": 2}\n')
  })

  it('añadir un parámetro a una función', () => {
    expect(
      change('def f(a):\n    return a\n', 'f', (c) =>
        c.kind === 'signature' ? { ...c, params: [...c.params, { name: 'b', value: '2' }] } : c,
      ),
    ).toBe('def f(a, b=2):\n    return a\n')
  })

  it('quitar un parámetro', () => {
    expect(
      change('def f(a, b):\n    return a\n', 'f', (c) =>
        c.kind === 'signature' ? { ...c, params: c.params.slice(0, 1) } : c,
      ),
    ).toBe('def f(a):\n    return a\n')
  })

  it('con anotaciones de tipo no se ofrece añadir o quitar: se perderían', () => {
    const node = find(parse('def f(a: int, b: str = "x"):\n    return a\n'), 'f')
    expect(node.sources?.['paramsList']).toBeUndefined()
  })

  it('el tipo y el mensaje de un raise', () => {
    expect(
      change('raise ValueError("mal")\n', 'error', (c) =>
        c.kind === 'signal' ? { ...c, errorType: 'TypeError', message: 'otro' } : c,
      ),
    ).toBe('raise TypeError("otro")\n')
  })

  it('el nombre del módulo de un import con alias', () => {
    const program = parse('import numpy as np\n')
    const node = program.nodes[0]
    if (!node?.control || node.control.kind !== 'module') throw new Error('sin import')
    expect(applyEdits(program.source, editsFor(node, { ...node.control, module: 'pandas' }))).toBe(
      'import pandas as np\n',
    )
  })
})

describe('el analizador conoce dónde está todo', () => {
  it('cada nodo lleva su rango, su texto editable y a quién pertenece', () => {
    const program = parse('def f(a):\n    x = a\n    y = 2\nz = 3\n')
    const x = find(program, 'x')
    expect(x.range).toMatchObject({ indent: 4, block: 2 })
    expect(x.range?.owner).toBe(find(program, 'f').id)
    expect(x.text).toBe('x = a')
    expect(find(program, 'z').range?.owner).toBeUndefined()
  })

  it('el texto de una sentencia compuesta es su cabecera, no su cuerpo', () => {
    const program = parse('def f(a):\n    return a\n')
    expect(find(program, 'f').text).toBe('def f(a):')
  })

  it('el programa lleva el texto que se analizó', () => {
    const src = 'a = 1\n'
    expect(parse(src).source).toBe(src)
  })

  it('pass no es un nodo: un cuerpo con solo un pass no tiene nada que dibujar', () => {
    const program = parse('def f():\n    pass\n')
    expect(program.nodes).toHaveLength(1)
    expect(program.unsupported).toEqual([])
  })
})

describe('valores por defecto que aparecen y desaparecen', () => {
  const change = (source: string, next: (c: ControlModel) => ControlModel) => {
    const program = parse(source)
    const node = program.nodes.find((n) => n.kind === 'abstraction.collapsed')
    if (!node?.control) throw new Error('sin editor')
    return applyEdits(source, editsFor(node, next(node.control)))
  }

  it('un parámetro sin valor por defecto puede recibir uno', () => {
    expect(
      change('def f(a, b):\n    return a\n', (c) =>
        c.kind === 'signature'
          ? { ...c, params: c.params.map((p) => (p.name === 'b' ? { ...p, value: '10' } : p)) }
          : c,
      ),
    ).toBe('def f(a, b=10):\n    return a\n')
  })

  it('y perderlo: queda un parámetro sin valor por defecto', () => {
    expect(
      change('def f(a, b=10):\n    return a\n', (c) =>
        c.kind === 'signature'
          ? { ...c, params: c.params.map((p) => (p.name === 'b' ? { ...p, value: '' } : p)) }
          : c,
      ),
    ).toBe('def f(a, b):\n    return a\n')
  })

  it('cambiar un valor por defecto que ya existía sigue tocando solo ese trozo', () => {
    expect(
      change('def f(a, b=10):\n    return a\n', (c) =>
        c.kind === 'signature'
          ? { ...c, params: c.params.map((p) => (p.name === 'b' ? { ...p, value: '20' } : p)) }
          : c,
      ),
    ).toBe('def f(a, b=20):\n    return a\n')
  })
})
