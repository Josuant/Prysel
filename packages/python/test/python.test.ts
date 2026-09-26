import { createRequire } from 'node:module'
import path from 'node:path'
import { analyze, channelOf, layout } from '@prysel/spatial'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, toSemanticGraph, type Program } from '../src/index.ts'

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => Program

beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source))
}, 30_000)

const SCRIPT = `import pandas as pd

THRESHOLD = 1000
sales = pd.read_csv("data/sales.csv")
big = sales[sales.amount > THRESHOLD]
summary = big.groupby("region").amount.sum()
display(summary)
`

describe('de Python a nodos', () => {
  it('reconoce cada sentencia con el tipo que le toca', () => {
    const { nodes } = parse(SCRIPT)
    const kinds = nodes.map((n) => n.kind)
    expect(kinds).toEqual([
      'external.import',
      'value.number',
      'effect.io',
      'control.condition',
      'transform.call',
      'output.display',
    ])
  })

  it('cada nodo conserva su línea y su código', () => {
    const { nodes } = parse(SCRIPT)
    expect(nodes[1]).toMatchObject({ label: 'THRESHOLD', line: 3, code: 'THRESHOLD = 1000' })
  })

  it('distingue un efecto externo de una transformación', () => {
    const { nodes } = parse('a = pd.read_csv("x")\nb = a.sum()\n')
    expect(nodes.map((n) => n.kind)).toEqual(['effect.io', 'transform.call'])
  })

  it('lo que no entiende lo marca como opaco en vez de inventárselo', () => {
    const { nodes, unsupported } = parse('assert x > 0\n')
    expect(nodes[0]?.kind).toBe('opaque.code')
    expect(unsupported[0]?.type).toBe('assert_statement')
  })

  it('aguanta código a medio escribir: es lo que permite dibujar mientras se teclea', () => {
    const { nodes } = parse('sales = pd.read_csv(\nbig = sales[')
    expect(nodes.length).toBeGreaterThan(0)
  })
})

describe('de nombres a conexiones', () => {
  it('conecta cada uso con la asignación que lo define', () => {
    const { nodes, edges } = parse(SCRIPT)
    const id = (label: string) => nodes.find((n) => n.label === label)?.id
    const between = (from?: string, to?: string) =>
      edges.find((e) => e.from === from && e.to === to)

    expect(between(id('pd'), id('sales'))?.relation).toBe('transform')
    expect(between(id('sales'), id('big'))?.relation).toBe('transform')
    expect(between(id('THRESHOLD'), id('big'))?.relation).toBe('dependency')
    expect(between(id('big'), id('summary'))?.relation).toBe('transform')
  })

  it('manda cada entrada a su puerto: el dato a un lado y el umbral al otro', () => {
    const { nodes, edges } = parse(SCRIPT)
    const id = (label: string) => nodes.find((n) => n.label === label)?.id
    const toFilter = edges.filter((e) => e.to === id('big'))
    expect(toFilter.find((e) => e.from === id('sales'))?.toPort).toBe('field')
    expect(toFilter.find((e) => e.from === id('THRESHOLD'))?.toPort).toBe('value')
  })

  it('un bucle se cierra con una conexión de retorno', () => {
    const { nodes, edges } = parse('total = 0\nfor row in rows:\n    total = total + row\n')
    const loop = nodes.find((n) => n.kind === 'control.loop')
    expect(edges.some((e) => e.relation === 'feedback' && e.to === loop?.id)).toBe(true)
    expect(loop?.contains?.length).toBe(1)
  })

  it('un if reparte sus ramas con etiqueta', () => {
    const { edges } = parse('if x > 1:\n    a = 1\nelse:\n    a = 2\n')
    const branches = edges.filter((e) => e.relation === 'branch')
    expect(branches.map((e) => e.label)).toEqual(['verdadero', 'falso'])
  })

  it('una función se queda con su cuerpo dentro', () => {
    const { nodes } = parse('def load(path):\n    a = open(path)\n    return a\n')
    const fn = nodes.find((n) => n.kind === 'abstraction.collapsed')
    expect(fn?.label).toBe('load')
    expect(fn?.contains).toHaveLength(2)
  })

  it('un import se conecta por referencia, no transporta un dato', () => {
    const { nodes, edges } = parse('import os\np = os.getcwd()\n')
    const imported = nodes.find((n) => n.kind === 'external.import')
    expect(edges.some((e) => e.from === imported?.id)).toBe(true)
  })
})

describe('el grafo resultante se puede dibujar', () => {
  it('pasa la gramática espacial sin solapes ni retrocesos', () => {
    const program = parse(SCRIPT)
    const graph = toSemanticGraph(program)
    const result = analyze(graph, layout(graph))
    expect(result.overlaps).toBe(0)
    expect(result.backward).toBe(0)
    expect(result.nodes).toBe(program.nodes.length)
  })

  it('reanalizar un archivo es lo bastante rápido para hacerlo en cada tecla', () => {
    const big = Array.from({ length: 200 }, (_, i) => `v${i} = v${Math.max(0, i - 1)} + ${i}`).join(
      '\n',
    )
    // Se mide lo que cuesta cada tecla, no el primer análisis del proceso (que paga la compilación
    // del propio código) ni un pico de carga de la máquina: se queda con el mejor de varios.
    const times: number[] = []
    let program = parse(big)
    for (let i = 0; i < 5; i++) {
      const started = performance.now()
      program = parse(big)
      times.push(performance.now() - started)
    }
    expect(program.nodes).toHaveLength(200)
    expect(Math.min(...times)).toBeLessThan(120)
  })
})

describe('control y datos son canales distintos', () => {
  it('las ramas de un if y el retorno de un bucle son control', () => {
    const { edges } = parse('if x > 1:\n    a = 1\nelse:\n    a = 2\n')
    const branches = edges.filter((e) => e.relation === 'branch')
    expect(branches).toHaveLength(2)
    expect(branches.every((e) => channelOf(e) === 'control')).toBe(true)

    const loop = parse('total = 0\nfor row in rows:\n    total = total + row\n')
    const returns = loop.edges.filter((e) => e.relation === 'feedback')
    expect(returns.length).toBeGreaterThan(0)
    expect(returns.every((e) => channelOf(e) === 'control')).toBe(true)
  })

  it('un bucle vuelve a empezar desde cada final de su cuerpo, no desde el if entero', () => {
    const source = [
      'for n in xs:',
      '    if n > 5:',
      '        a = 1',
      '    else:',
      '        b = 2',
      'while x:',
      '    if x == 4:',
      '        break',
      'for m in ys:',
      '    if m:',
      '        break',
      '    continue',
      '',
    ].join('\n')
    const { nodes, edges } = parse(source)
    const at = (line: number) => nodes.find((n) => n.line === line)?.id
    const into = (line: number) =>
      edges
        .filter((e) => e.relation === 'feedback' && e.to === at(line))
        .map((e) => nodes.find((n) => n.id === e.from)?.line)
        .sort()
    // Con else: desde el final de cada camino.
    expect(into(1)).toEqual([3, 5])
    // Sin else: desde la propia decisión (su camino «no»); el break no vuelve.
    expect(into(6)).toEqual([7])
    // Un cuerpo que acaba en un salto no vuelve por el retorno (el continue ya salta a la cabecera).
    expect(into(9)).toEqual([])
  })

  it('entrar al cuerpo de un bucle es control aunque se trace como una transformación', () => {
    const { nodes, edges } = parse('for row in rows:\n    print(row)\n')
    const loop = nodes.find((n) => n.kind === 'control.loop')
    const entry = edges.find((e) => e.from === loop?.id && e.relation === 'transform')
    expect(entry).toBeDefined()
    expect(entry && channelOf(entry)).toBe('control')
  })

  it('pasar una variable a una operación es datos', () => {
    const { nodes, edges } = parse('a = 1\nb = a + 1\n')
    const from = nodes.find((n) => n.label === 'a')?.id
    const to = nodes.find((n) => n.label === 'b')?.id
    const link = edges.find((e) => e.from === from && e.to === to)
    expect(link).toBeDefined()
    expect(link && channelOf(link)).toBe('data')
  })
})

describe('una función encierra todo su cuerpo, no solo su primer nivel', () => {
  const MAIN = [
    'numero2 = 3',
    'def _main():',
    '    if numero2 < 0:',
    '        print("negativo")',
    '    else:',
    '        resultado = numero2 + 1',
    '        print(resultado)',
    '',
  ].join('\n')

  it('las ramas de un if indentadas dentro del def le pertenecen', () => {
    const { nodes } = parse(MAIN)
    const main = nodes.find((n) => n.kind === 'abstraction.collapsed')
    const inside = nodes.filter((n) => n.label !== 'numero2' && n.id !== main?.id).map((n) => n.id)
    expect(inside).toHaveLength(4) // el if, un print, la asignación y el otro print
    expect(main?.contains).toEqual(inside)
  })

  it('y el layout las dibuja físicamente dentro del contenedor', () => {
    const program = parse(MAIN)
    const result = layout(toSemanticGraph(program, 'compact'))
    const main = program.nodes.find((n) => n.kind === 'abstraction.collapsed')
    const frame = result.placements.find((p) => p.id === main?.id)
    expect(frame).toBeDefined()
    for (const id of main?.contains ?? []) {
      const p = result.placements.find((q) => q.id === id)
      expect(p, id).toBeDefined()
      if (!p || !frame) continue
      expect(p.x).toBeGreaterThanOrEqual(frame.x)
      expect(p.y).toBeGreaterThanOrEqual(frame.y)
      expect(p.x + p.size.w).toBeLessThanOrEqual(frame.x + frame.size.w)
      expect(p.y + p.size.h).toBeLessThanOrEqual(frame.y + frame.size.h)
    }
  })

  it('lo de fuera se queda fuera', () => {
    const program = parse(MAIN)
    const result = layout(toSemanticGraph(program, 'compact'))
    const outside = program.nodes.find((n) => n.label === 'numero2')
    const main = program.nodes.find((n) => n.kind === 'abstraction.collapsed')
    const a = result.placements.find((p) => p.id === outside?.id)
    const f = result.placements.find((p) => p.id === main?.id)
    expect(
      a &&
        f &&
        (a.x + a.size.w <= f.x ||
          a.x >= f.x + f.size.w ||
          a.y + a.size.h <= f.y ||
          a.y >= f.y + f.size.h),
    ).toBe(true)
  })

  it('un def dentro de un def conserva su propio cuerpo', () => {
    const program = parse(
      'def a():\n    x = 1\n    def b():\n        y = 2\n        z = y\n    w = x\n',
    )
    const result = layout(toSemanticGraph(program, 'compact'))
    const [outer, inner] = program.nodes.filter((n) => n.kind === 'abstraction.collapsed')
    expect(result.scopes[inner?.id ?? '']).toHaveLength(2)
    expect(result.scopes[outer?.id ?? '']).toContain(inner?.id)
    expect(result.scopes[outer?.id ?? '']).not.toContain(
      program.nodes.find((n) => n.label === 'z')?.id,
    )
  })
})

describe('un nodo enseña lo que significa, no la sintaxis que lo escribió', () => {
  const byLabel = (program: Program, label: string) => program.nodes.find((n) => n.label === label)

  it('un print es un mensaje: sin la palabra print y sin comillas', () => {
    const { nodes } = parse('print("Hola")\n')
    expect(nodes[0]).toMatchObject({
      label: 'Imprimir',
      control: { kind: 'text', value: 'Hola', multiline: false },
    })
  })

  it('un mensaje largo o de varias líneas crece; uno corto cabe en una fila', () => {
    const long = parse('print("El número ingresado es negativo. Por favor, ingresa otro.")\n')
    expect(long.nodes[0]?.control).toMatchObject({ kind: 'text', multiline: true })
    const lines = parse('print("""uno\ndos""")\n')
    expect(lines.nodes[0]?.control).toMatchObject({ kind: 'text', multiline: true })
  })

  it('un f-string conserva sus huecos y sus valores entran por el campo del mensaje', () => {
    const program = parse('a = 1\nprint(f"vale {a}")\n')
    const message = byLabel(program, 'Imprimir')
    expect(message?.control).toMatchObject({ kind: 'text', value: 'vale {a}' })
    expect(program.edges.find((e) => e.to === message?.id)?.toPort).toBe('value')
  })

  it('un literal numérico enseña solo el número', () => {
    const { nodes } = parse('numeroA = 5\n')
    expect(nodes[0]?.control).toEqual({ kind: 'number', value: 5 })
  })

  it('una cadena y un booleano también', () => {
    const { nodes } = parse('nombre = "Ana"\nactivo = True\n')
    expect(nodes[0]?.control).toMatchObject({ kind: 'text', value: 'Ana' })
    expect(nodes[1]?.control).toEqual({ kind: 'boolean', value: true })
  })

  it('cada argumento de una función propia lleva el nombre de su parámetro', () => {
    const program = parse('def suma(a, b):\n    return a + b\nx = 1\ny = 2\nr = suma(x, y)\n')
    const call = byLabel(program, 'r')
    expect(call?.control).toMatchObject({
      kind: 'args',
      target: 'suma',
      args: [
        { name: 'a', value: 'x' },
        { name: 'b', value: 'y' },
      ],
    })
    // Y los dos cables llegan a campos distintos: se sabe cuál alimenta a cuál.
    const into = program.edges.filter((e) => e.to === call?.id)
    const port = (from: string) => into.find((e) => e.from === byLabel(program, from)?.id)?.toPort
    expect(port('x')).toBe('arg:a')
    expect(port('y')).toBe('arg:b')
  })

  it('un argumento con nombre conserva el suyo', () => {
    const { nodes } = parse('r = f(1, tope=3)\n')
    expect(nodes[0]?.control).toMatchObject({
      kind: 'args',
      args: [
        { name: 'arg1', value: '1' },
        { name: 'tope', value: '3' },
      ],
    })
  })

  it('una condición se separa en campo, operador y valor', () => {
    const { nodes } = parse('if numero2 < 0:\n    pass\n')
    expect(nodes[0]?.control).toMatchObject({
      kind: 'condition',
      field: 'numero2',
      operator: '<',
      value: '0',
    })
  })

  it('un return con una operación son dos operandos y un operador', () => {
    const { nodes } = parse('def f(a, b):\n    return a + b\n')
    const ret = nodes.find((n) => n.kind === 'control.return')
    expect(ret?.control).toMatchObject({ kind: 'expression', left: 'a', operator: '+', right: 'b' })
  })

  it('un bucle dice su variable y lo que recorre', () => {
    const { nodes } = parse('for n in range(10):\n    pass\n')
    expect(nodes[0]?.control).toMatchObject({ kind: 'loop', variable: 'n', iterable: 'range(10)' })
  })

  it('una función enseña su firma', () => {
    const { nodes } = parse('def f(a, b=2):\n    return a\n')
    expect(nodes[0]?.control).toEqual({
      kind: 'signature',
      params: [
        { name: 'a', value: '' },
        { name: 'b', value: '2' },
      ],
    })
  })

  it('lo que no tiene un editor propio se enseña entero como destino y valor, sin perder nada', () => {
    const { nodes } = parse('r = f(*args)\nok = 1 < x < 3\nz = df.groupby("k").sum()\n')
    expect(nodes.map((n) => n.control)).toEqual([
      { kind: 'assign', destination: 'r', value: 'f(*args)' },
      { kind: 'assign', destination: 'ok', value: '1 < x < 3' },
      {
        kind: 'chain',
        receiver: 'df',
        steps: [
          { kind: 'call', name: 'groupby', args: '"k"' },
          { kind: 'call', name: 'sum', args: '' },
        ],
      },
    ])
  })

  it('lo que sigue sin poder escribirse en un campo (varias líneas) se queda como código', () => {
    const { nodes } = parse('r = f(\n    1,\n    *args,\n)\n')
    expect(nodes[0]?.control).toBeUndefined()
  })

  it('no lee cada nombre como argumento dos veces', () => {
    const program = parse('a = 1\nr = f(a, a)\n')
    const into = program.edges.filter(
      (e) => e.to === byLabel(program, 'r')?.id && e.relation !== 'sequence',
    )
    expect(into.filter((e) => e.from === byLabel(program, 'a')?.id)).toHaveLength(1)
  })
})

describe('una llamada a una función del archivo sabe a cuál llama', () => {
  it('lleva el id de la definición', () => {
    const { nodes } = parse('def suma(a, b):\n    return a + b\nr = suma(1, 2)\n')
    const def = nodes.find((n) => n.kind === 'abstraction.collapsed')
    const call = nodes.find((n) => n.label === 'r')
    expect(call?.calls).toBe(def?.id)
  })

  it('también dentro de otra función, y como sentencia suelta', () => {
    const { nodes } = parse('def f(x):\n    return x\ndef g():\n    f(1)\n    y = f(2)\n')
    const f = nodes.find((n) => n.label === 'f')
    const calls = nodes.filter((n) => n.calls !== undefined)
    expect(calls).toHaveLength(2)
    expect(calls.every((n) => n.calls === f?.id)).toBe(true)
  })

  it('una llamada a algo que el archivo no define no lleva a ningún sitio', () => {
    const { nodes } = parse('r = int("3")\n')
    expect(nodes[0]?.calls).toBeUndefined()
  })
})

describe('los comentarios no se pierden: van donde explican', () => {
  const noteOf = (program: Program, label: string) =>
    program.nodes.find((n) => n.label === label)?.note

  it('el docstring de una función va en su nodo, no como una sentencia más', () => {
    const program = parse('def suma(a, b):\n    """Suma dos números."""\n    return a + b\n')
    const def = program.nodes.find((n) => n.kind === 'abstraction.collapsed')
    expect(def?.note).toBe('Suma dos números.')
    // El docstring no genera un nodo propio: el cuerpo es solo el return.
    expect(def?.contains).toHaveLength(1)
    expect(program.nodes.filter((n) => n.kind === 'value.str')).toHaveLength(0)
  })

  it('un docstring de varias líneas se limpia de comillas y de sangría', () => {
    const program = parse(
      'def f():\n    """Resumen.\n\n    Detalle en\n    dos líneas.\n    """\n    return 1\n',
    )
    expect(noteOf(program, 'f')).toBe('Resumen.\n\nDetalle en\ndos líneas.')
  })

  it('el comentario justo debajo de la firma explica la función', () => {
    const program = parse('def f(a):\n    # Devuelve el doble.\n    return a * 2\n')
    expect(noteOf(program, 'f')).toBe('Devuelve el doble.')
  })

  it('el comentario en la línea de la firma también', () => {
    const program = parse('def f(a):  # el doble\n    return a * 2\n')
    expect(noteOf(program, 'f')).toBe('el doble')
  })

  it('el comentario encima del def explica la función', () => {
    const program = parse('# Calcula el total.\ndef total(xs):\n    return sum(xs)\n')
    expect(noteOf(program, 'total')).toBe('Calcula el total.')
  })

  it('un comentario y un docstring conviven: primero lo uno, luego lo otro', () => {
    const program = parse('# Nota de autor\ndef f():\n    """Hace algo."""\n    return 1\n')
    expect(noteOf(program, 'f')).toBe('Nota de autor\n\nHace algo.')
  })

  it('un comentario en línea es de la sentencia en cuya línea está', () => {
    const program = parse('x = 5  # el tope\ny = 6\n')
    expect(noteOf(program, 'x')).toBe('el tope')
    expect(noteOf(program, 'y')).toBeUndefined()
  })

  it('un comentario solo en su línea explica la sentencia que viene detrás', () => {
    const program = parse('# el umbral\nlimite = 10\notro = 1\n')
    expect(noteOf(program, 'limite')).toBe('el umbral')
    expect(noteOf(program, 'otro')).toBeUndefined()
  })

  it('varias líneas de comentario seguidas se conservan juntas', () => {
    const program = parse('# primera\n# segunda\nx = 1\n')
    expect(noteOf(program, 'x')).toBe('primera\nsegunda')
  })

  it('un comentario al final de un bloque cierra la última sentencia', () => {
    const program = parse('if a:\n    x = 1\n    # fin de la rama\n')
    expect(noteOf(program, 'x')).toBe('fin de la rama')
  })

  it('dentro de una rama, un comentario explica lo de esa rama', () => {
    const program = parse('if a:\n    # caso feliz\n    x = 1\nelse:\n    y = 2\n')
    expect(noteOf(program, 'x')).toBe('caso feliz')
    expect(noteOf(program, 'y')).toBeUndefined()
  })

  it('el comentario de la cabecera de un if o un bucle es del if o del bucle', () => {
    const program = parse('for n in xs:  # recorre todo\n    pass\n')
    expect(program.nodes.find((n) => n.kind === 'control.loop')?.note).toBe('recorre todo')
  })

  it('el docstring del archivo explica lo que viene detrás', () => {
    const program = parse('"""Cálculos de ventas."""\nx = 1\n')
    expect(noteOf(program, 'x')).toBe('Cálculos de ventas.')
    expect(program.nodes).toHaveLength(1)
  })

  it('el shebang y la declaración de codificación no son prosa', () => {
    const program = parse('#!/usr/bin/env python\n# -*- coding: utf-8 -*-\nx = 1\n')
    expect(noteOf(program, 'x')).toBeUndefined()
  })

  it('un f-string al principio no es un docstring', () => {
    const program = parse('def f(a):\n    f"hola {a}"\n    return a\n')
    expect(noteOf(program, 'f')).toBeUndefined()
  })

  it('un comentario solo, sin ninguna sentencia, no rompe nada', () => {
    expect(parse('# nada más\n').nodes).toEqual([])
  })

  it('los ids no cambian al editar dentro de una línea', () => {
    const before = parse('a = 1\nb = 2\n')
    const after = parse('a = 1000000  # más largo\nb = 2\n')
    expect(after.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id))
  })
})
