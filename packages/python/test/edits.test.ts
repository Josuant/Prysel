import { createRequire } from 'node:module'
import path from 'node:path'
import type { ControlModel } from '@prysel/morphology'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyEdits, editsFor, escapeString, validEdits } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

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

/** Cambia un campo del editor de un nodo, escribe de vuelta y vuelve a analizar. */
function edit(source: string, label: string, change: (control: ControlModel) => ControlModel) {
  const before = parse(source)
  const node = before.nodes.find((n) => n.label === label)
  if (!node?.control) throw new Error(`sin editor para ${label}`)
  const edits = editsFor(node, change(node.control))
  const after = applyEdits(source, edits)
  return { edits, text: after, program: parse(after), node }
}

const find = (program: Program, label: string): ProgramNode | undefined =>
  program.nodes.find((n) => n.label === label)

describe('un cambio en el editor reescribe solo ese trozo de Python', () => {
  it('un número', () => {
    const { text, program } = edit('a = 5\nb = 6\n', 'a', (c) =>
      c.kind === 'number' ? { ...c, value: 42 } : c,
    )
    expect(text).toBe('a = 42\nb = 6\n')
    expect(find(program, 'a')?.control).toEqual({ kind: 'number', value: 42 })
  })

  it('un flotante sigue siendo un flotante', () => {
    const { text } = edit('a = 5.0\n', 'a', (c) => (c.kind === 'number' ? { ...c, value: 7 } : c))
    expect(text).toBe('a = 7.0\n')
  })

  it('un número negativo o decimal', () => {
    const negative = edit('a = 5\n', 'a', (c) => (c.kind === 'number' ? { ...c, value: -3 } : c))
    expect(negative.text).toBe('a = -3\n')
    const decimal = edit('a = 5\n', 'a', (c) => (c.kind === 'number' ? { ...c, value: 2.5 } : c))
    expect(decimal.text).toBe('a = 2.5\n')
  })

  it('un booleano', () => {
    const { text, program } = edit('activo = True\n', 'activo', (c) =>
      c.kind === 'boolean' ? { ...c, value: false } : c,
    )
    expect(text).toBe('activo = False\n')
    expect(find(program, 'activo')?.control).toEqual({ kind: 'boolean', value: false })
  })

  it('el mensaje de un print, sin tocar la palabra print ni las comillas', () => {
    const { text, program } = edit('print("hola")\n', 'Imprimir', (c) =>
      c.kind === 'text' ? { ...c, value: 'adiós, mundo' } : c,
    )
    expect(text).toBe('print("adiós, mundo")\n')
    expect(program.nodes[0]?.control).toMatchObject({ kind: 'text', value: 'adiós, mundo' })
  })

  it('un f-string conserva sus huecos y su prefijo', () => {
    const { text } = edit('a = 1\nprint(f"vale {a}")\n', 'Imprimir', (c) =>
      c.kind === 'text' ? { ...c, value: 'ahora {a} y más' } : c,
    )
    expect(text).toBe('a = 1\nprint(f"ahora {a} y más")\n')
  })

  it('una cadena con comillas simples conserva sus comillas', () => {
    const { text } = edit("nombre = 'Ana'\n", 'nombre', (c) =>
      c.kind === 'text' ? { ...c, value: 'Luis' } : c,
    )
    expect(text).toBe("nombre = 'Luis'\n")
  })

  it('el operador y los operandos de una operación', () => {
    const { text, program } = edit('c = a + b\n', 'c', (c) =>
      c.kind === 'expression' ? { ...c, operator: '*', right: 'b * 2' } : c,
    )
    expect(text).toBe('c = a * b * 2\n')
    expect(find(program, 'c')?.control).toMatchObject({ kind: 'expression', operator: '*' })
  })

  it('una condición: campo, operador y valor', () => {
    const { text, program } = edit('if x < 0:\n    pass\n', '¿x < 0?', (c) =>
      c.kind === 'condition' ? { ...c, operator: '>=', value: '10' } : c,
    )
    expect(text).toBe('if x >= 10:\n    pass\n')
    expect(program.nodes[0]?.control).toMatchObject({
      kind: 'condition',
      operator: '>=',
      value: '10',
    })
  })

  it('el argumento de una llamada, por nombre', () => {
    const { text } = edit('def f(a, b):\n    pass\nr = f(x, y)\n', 'r', (c) =>
      c.kind === 'args'
        ? { ...c, args: c.args.map((arg) => (arg.name === 'b' ? { ...arg, value: 'z + 1' } : arg)) }
        : c,
    )
    expect(text).toBe('def f(a, b):\n    pass\nr = f(x, z + 1)\n')
  })

  it('la secuencia de un bucle', () => {
    const { text } = edit('for n in range(3):\n    pass\n', 'cada n', (c) =>
      c.kind === 'loop' ? { ...c, iterable: 'range(10)' } : c,
    )
    expect(text).toBe('for n in range(10):\n    pass\n')
  })

  it('un valor por defecto', () => {
    const { text } = edit('def f(a, tope=3):\n    return a\n', 'f', (c) =>
      c.kind === 'signature'
        ? {
            ...c,
            params: c.params.map((p) => (p.name === 'tope' ? { ...p, value: '99' } : p)),
          }
        : c,
    )
    expect(text).toBe('def f(a, tope=99):\n    return a\n')
  })

  it('un return con una operación', () => {
    const { text } = edit('def f(a, b):\n    return a + b\n', 'devolver', (c) =>
      c.kind === 'expression' ? { ...c, operator: '-' } : c,
    )
    expect(text).toBe('def f(a, b):\n    return a - b\n')
  })

  it('una asignación aumentada: cambia el operador y lo de la derecha, no la variable asignada', () => {
    const { text, program } = edit('acc += n\n', 'acc', () => ({
      kind: 'expression',
      left: 'otra',
      operator: '-=',
      right: 'm * 2',
      operators: ['-='],
    }))
    expect(text).toBe('acc -= m * 2\n')
    expect(find(program, 'acc')?.control).toMatchObject({ kind: 'expression', left: 'acc' })
  })
})

describe('los desplazamientos son de cadena: no se descuadran con caracteres no ASCII', () => {
  const source = '# número de café\nnombre = "ñandú"\nedad = 5\nprint("¿Cuántos años, José?")\n'

  it('un campo después de tildes y eñes cae en su sitio', () => {
    const { text } = edit(source, 'edad', (c) => (c.kind === 'number' ? { ...c, value: 6 } : c))
    expect(text).toBe(source.replace('edad = 5', 'edad = 6'))
  })

  it('el contenido con tildes se reescribe entero', () => {
    const { text } = edit(source, 'Imprimir', (c) =>
      c.kind === 'text' ? { ...c, value: '¿Qué tal, Ángel?' } : c,
    )
    expect(text).toBe(source.replace('¿Cuántos años, José?', '¿Qué tal, Ángel?'))
  })
})

describe('lo que se escribe no rompe el código', () => {
  it('una comilla dentro de una cadena se escapa', () => {
    const { text, program } = edit('print("hola")\n', 'Imprimir', (c) =>
      c.kind === 'text' ? { ...c, value: 'dijo "adiós"' } : c,
    )
    expect(text).toBe('print("dijo \\"adiós\\"")\n')
    expect(program.nodes).toHaveLength(1)
    expect(program.nodes[0]?.control?.kind).toBe('text')
  })

  it('un salto de línea en una cadena de una línea se escribe como \\n', () => {
    const { text } = edit('print("hola")\n', 'Imprimir', (c) =>
      c.kind === 'text' ? { ...c, value: 'línea 1\nlínea 2' } : c,
    )
    expect(text).toBe('print("línea 1\\nlínea 2")\n')
  })

  it('una cadena entre comillas triples admite saltos de línea tal cual', () => {
    const { text } = edit('a = """hola"""\n', 'a', (c) =>
      c.kind === 'text' ? { ...c, value: 'uno\ndos' } : c,
    )
    expect(text).toBe('a = """uno\ndos"""\n')
  })

  it('una expresión vacía no se escribe: se conserva la que había', () => {
    const { edits, text } = edit('c = a + b\n', 'c', (c) =>
      c.kind === 'expression' ? { ...c, left: '   ' } : c,
    )
    expect(edits).toEqual([])
    expect(text).toBe('c = a + b\n')
  })

  it('una expresión de varias líneas tampoco', () => {
    const { edits } = edit('c = a + b\n', 'c', (c) =>
      c.kind === 'expression' ? { ...c, left: 'a\n+ z' } : c,
    )
    expect(edits).toEqual([])
  })

  it('una cadena cruda no se ofrece para reescribir: cambiaría lo que significa', () => {
    const program = parse('ruta = r"C:\\datos"\n')
    expect(program.nodes[0]?.control).toMatchObject({ kind: 'text' })
    expect(program.nodes[0]?.sources).toBeUndefined()
  })

  it('un valor sin cambios no genera ninguna edición', () => {
    const { edits } = edit('a = 5\n', 'a', (c) => c)
    expect(edits).toEqual([])
  })

  it('un modelo de otro tipo no se aplica', () => {
    const { edits } = edit('a = 5\n', 'a', () => ({ kind: 'boolean', value: true }))
    expect(edits).toEqual([])
  })
})

describe('escapar una cadena', () => {
  it('protege solo lo que la rompería', () => {
    expect(escapeString('sin nada', '"')).toBe('sin nada')
    expect(escapeString('con "comillas"', '"')).toBe('con \\"comillas\\"')
    expect(escapeString("con 'simples'", "'")).toBe("con \\'simples\\'")
    expect(escapeString('con "comillas"', "'")).toBe('con "comillas"')
  })

  it('respeta un escape que ya estaba escrito', () => {
    expect(escapeString('ya \\" escapada', '"')).toBe('ya \\" escapada')
    expect(escapeString('\\n literal', '"')).toBe('\\n literal')
  })

  it('una barra suelta al final no se come la comilla de cierre', () => {
    expect(escapeString('ruta\\', '"')).toBe('ruta\\\\')
    expect(escapeString('ruta\\\\', '"')).toBe('ruta\\\\')
  })

  it('entre comillas triples, una comilla final no cierra la cadena antes de tiempo', () => {
    expect(escapeString('dice "hola"', '"""')).toBe('dice "hola\\"')
  })
})

describe('validar y aplicar ediciones', () => {
  const edits = [
    { start: 0, end: 1, text: 'x' },
    { start: 3, end: 5, text: 'yy' },
  ]

  it('acepta ediciones ordenadas, separadas y dentro del texto', () => {
    expect(validEdits(edits, 10)).toBe(true)
  })

  it('rechaza las que se pisan, se salen del texto o no son enteros', () => {
    expect(
      validEdits(
        [
          { start: 0, end: 4, text: '' },
          { start: 3, end: 5, text: '' },
        ],
        10,
      ),
    ).toBe(false)
    expect(validEdits([{ start: 0, end: 11, text: '' }], 10)).toBe(false)
    expect(validEdits([{ start: 2, end: 1, text: '' }], 10)).toBe(false)
    expect(validEdits([{ start: 0.5, end: 1, text: '' }], 10)).toBe(false)
    expect(validEdits([{ start: -1, end: 1, text: '' }], 10)).toBe(false)
  })

  it('aplica varias ediciones sin que una descoloque a la otra', () => {
    expect(applyEdits('abcdefgh', edits)).toBe('xbcyyfgh')
  })
})
