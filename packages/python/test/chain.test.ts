import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ChainStep } from '@prysel/morphology'
import { actionEdits, applyEdits, chainText, editsFor } from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program, type ProgramNode } from '../src/index.ts'

/**
 * Una cadena de pasos (`df.groupby("mes")["monto"].sum().reset_index()`) se enseña como un receptor y
 * una lista de pasos: cada método, índice o atributo es un paso que se puede editar, quitar o añadir.
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

const chainOf = (source: string, line = 1) => {
  const control = at(parse(source), line).control
  return control?.kind === 'chain' ? control : undefined
}

const call = (name: string, args = ''): ChainStep => ({ kind: 'call', name, args })

describe('qué es una cadena', () => {
  it('un receptor y varios pasos: llamadas, índices y atributos', () => {
    expect(chainOf('por_mes = df.groupby("mes")["monto"].sum().reset_index()\n')).toEqual({
      kind: 'chain',
      receiver: 'df',
      steps: [
        call('groupby', '"mes"'),
        { kind: 'index', name: '', args: '"monto"' },
        call('sum'),
        call('reset_index'),
      ],
    })
    expect(chainOf('m = df["fecha"].dt.month\n')).toEqual({
      kind: 'chain',
      receiver: 'df',
      steps: [
        { kind: 'index', name: '', args: '"fecha"' },
        { kind: 'attr', name: 'dt', args: '' },
        { kind: 'attr', name: 'month', args: '' },
      ],
    })
  })

  it('los atributos del principio son el camino al receptor, no pasos', () => {
    expect(chainOf('p = self.model.fit(X).predict(Z)\n')).toEqual({
      kind: 'chain',
      receiver: 'self.model',
      steps: [call('fit', 'X'), call('predict', 'Z')],
    })
    // `os.path.join(a, b)` es una sola llamada: no es una cadena.
    expect(chainOf('p = os.path.join(a, b)\n')).toBeUndefined()
  })

  it('una llamada a una función suelta es el receptor: `f(x).g().h()`', () => {
    expect(chainOf('r = f(x).g().h(1)\n')).toEqual({
      kind: 'chain',
      receiver: 'f(x)',
      steps: [call('g'), call('h', '1')],
    })
  })

  it('un solo paso no es una cadena', () => {
    for (const source of [
      'a = df.dropna(subset=["x"])\n',
      'a, b = plt.subplots(figsize=(8, 4))\n',
      'a = df["x"]\n',
      'a = df.x\n',
      'a = f(x)\n',
    ]) {
      expect(chainOf(source)).toBeUndefined()
    }
  })

  it('una cadena en varias líneas entre paréntesis, con cada trozo en una línea', () => {
    const source = 'x = (df.groupby("a")\n     .sum()\n     .reset_index())\n'
    const node = at(parse(source), 1)
    expect(node.control).toMatchObject({ kind: 'chain', receiver: 'df' })
    expect(node.kind).toBe('transform.call')
  })

  it('un trozo que ocupa varias líneas no se representa: se enseña el código', () => {
    expect(chainOf('x = df.agg(\n    {"a": "sum"}\n).reset_index()\n')?.kind).toBeUndefined()
  })

  it('una cadena que acaba en un índice no es una condición aunque lleve `<`', () => {
    const node = at(parse('m = df.groupby("a")["b"]\n'), 1)
    expect(node.kind).toBe('transform.call')
    expect(node.control?.kind).toBe('chain')
    expect(at(parse('m = df[df.a < 3].sum()\n'), 1).control?.kind).toBe('chain')
  })

  it('una sentencia suelta también: `df.head().describe()`', () => {
    expect(chainOf('df.head().describe()\n')?.steps).toHaveLength(2)
  })

  it('sigue dejando su resultado como nombre, y los nodos siguientes lo leen', () => {
    const program = parse('r = df.a().b()\nprint(r)\n')
    expect(at(program, 1).provides).toBe('r')
    expect(
      program.edges.some((e) => e.from === at(program, 1).id && e.to === at(program, 2).id),
    ).toBe(true)
  })
})

describe('de dónde sale cada paso', () => {
  it('ancla la cadena: línea y columna (en bytes) donde empieza', () => {
    expect(at(parse('x = 1\nr = df.a().b()\n'), 2).anchor).toEqual({ line: 2, col: 4 })
    // `é` ocupa dos bytes: el intérprete cuenta en UTF-8.
    expect(at(parse('é = df.a().b()\n'), 1).anchor).toEqual({ line: 1, col: 5 })
  })

  it('el receptor acepta un cable; lo que hay dentro de los pasos, no', () => {
    const node = at(parse('col = "a"\nr = df.groupby(col).sum()\n'), 2)
    expect(Object.keys(node.inputs ?? {})).toEqual(['receiver'])
    expect(node.sources?.['steps[0].args']).toMatchObject({ as: 'arguments' })
  })

  it('un nombre del receptor entra por su puerto', () => {
    const program = parse('df = load()\nr = df.a().b()\n')
    const node = at(program, 2)
    expect(
      program.edges.some(
        (e) => e.from === at(program, 1).id && e.to === node.id && e.toPort === 'receiver',
      ),
    ).toBe(true)
  })

  it('llevar un valor al receptor lo escribe', () => {
    const source = 'otro = load()\nr = df.a().b()\n'
    const program = parse(source)
    const text = applyEdits(
      source,
      actionEdits(program, {
        type: 'connect',
        from: at(program, 1).id,
        to: at(program, 2).id,
        slot: 'receiver',
      }).edits,
    )
    expect(text).toBe('otro = load()\nr = otro.a().b()\n')
  })
})

describe('editar una cadena', () => {
  const SOURCE = 'r = df.groupby("mes").sum().reset_index()\n'
  const edited = (
    change: (steps: ChainStep[]) => ChainStep[],
    receiver = 'df',
    source = SOURCE,
  ) => {
    const node = at(parse(source), 1)
    const control = node.control
    if (control?.kind !== 'chain') throw new Error('sin cadena')
    return applyEdits(
      source,
      editsFor(node, { kind: 'chain', receiver, steps: change(control.steps) }),
    )
  }

  it('cambiar el método de un paso, o sus argumentos, reescribe solo eso', () => {
    expect(edited((s) => s.map((x, i) => (i === 1 ? { ...x, name: 'mean' } : x)))).toBe(
      'r = df.groupby("mes").mean().reset_index()\n',
    )
    expect(
      edited((s) => s.map((x, i) => (i === 0 ? { ...x, args: '"dia", as_index=False' } : x))),
    ).toBe('r = df.groupby("dia", as_index=False).sum().reset_index()\n')
  })

  it('unos argumentos vacíos se pueden llenar, y llenos se pueden vaciar', () => {
    expect(edited((s) => s.map((x, i) => (i === 1 ? { ...x, args: 'axis=0' } : x)))).toBe(
      'r = df.groupby("mes").sum(axis=0).reset_index()\n',
    )
    expect(edited((s) => s.map((x, i) => (i === 0 ? { ...x, args: '' } : x)))).toBe(
      'r = df.groupby().sum().reset_index()\n',
    )
  })

  it('cambiar el receptor', () => {
    expect(edited((s) => s, 'ventas')).toBe('r = ventas.groupby("mes").sum().reset_index()\n')
  })

  it('quitar un paso reescribe la cadena', () => {
    expect(edited((s) => s.filter((_, i) => i !== 1))).toBe('r = df.groupby("mes").reset_index()\n')
  })

  it('añadir un paso al final, o en medio', () => {
    expect(edited((s) => [...s, call('head', '3')])).toBe(
      'r = df.groupby("mes").sum().reset_index().head(3)\n',
    )
    expect(edited((s) => [s[0] as ChainStep, call('fillna', '0'), ...s.slice(1)])).toBe(
      'r = df.groupby("mes").fillna(0).sum().reset_index()\n',
    )
  })

  it('intercambiar dos pasos del mismo tipo', () => {
    expect(edited((s) => [s[0] as ChainStep, s[2] as ChainStep, s[1] as ChainStep])).toBe(
      'r = df.groupby("mes").reset_index().sum()\n',
    )
  })

  it('cambiar el tipo de un paso (una llamada en un índice) reescribe la cadena', () => {
    expect(
      edited((s) => s.map((x, i) => (i === 1 ? { kind: 'index', name: '', args: '"monto"' } : x))),
    ).toBe('r = df.groupby("mes")["monto"].reset_index()\n')
  })

  it('una cadena en varias líneas entre paréntesis se reescribe en una', () => {
    const source = 'x = (df.groupby("a")\n     .sum()\n     .reset_index())\n'
    expect(edited((s) => s.slice(0, 2), 'df', source)).toBe('x = (df.groupby("a").sum())\n')
  })

  it('cambiar el texto de un paso en una cadena de varias líneas conserva su formato', () => {
    const source = 'x = (df.groupby("a")\n     .sum()\n     .reset_index())\n'
    expect(
      edited((s) => s.map((x, i) => (i === 1 ? { ...x, name: 'mean' } : x)), 'df', source),
    ).toBe('x = (df.groupby("a")\n     .mean()\n     .reset_index())\n')
  })

  it('lo que no se puede escribir no toca nada', () => {
    expect(edited((s) => s.map((x, i) => (i === 0 ? { ...x, args: 'a\nb' } : x)))).toBe(SOURCE)
    expect(edited((s) => [...s, call('no es un nombre')])).toBe(SOURCE)
    expect(edited((s) => s, '')).toBe(SOURCE)
  })

  it('el texto de una cadena, en una línea', () => {
    expect(
      chainText({
        kind: 'chain',
        receiver: 'df',
        steps: [
          call('a', '1'),
          { kind: 'index', name: '', args: '"x"' },
          { kind: 'attr', name: 'T', args: '' },
        ],
      }),
    ).toBe('df.a(1)["x"].T')
    expect(chainText({ kind: 'chain', receiver: 'df', steps: [] })).toBeNull()
    expect(
      chainText({ kind: 'chain', receiver: 'df', steps: [{ kind: 'index', name: '', args: '' }] }),
    ).toBeNull()
  })
})
