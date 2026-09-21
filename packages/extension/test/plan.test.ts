import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import {
  fileLine,
  freshness,
  planAll,
  planRun,
  reconcile,
  statements,
  topLevelOf,
  type Ran,
  type Statement,
} from '../src/plan.ts'

/**
 * Qué ejecutar y en qué orden: las sentencias de primer nivel, lo que cada una necesita, y qué
 * resultados dejan de valer tras una edición.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => { program: Program; stmts: Statement[] }

beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source) => {
    const program = buildProgram(parser.parse(source), source)
    return { program, stmts: statements(program, source) }
  }
}, 30_000)

/** Las dependencias como «línea ← líneas», para leerlas de un vistazo. */
const depsByLine = (stmts: Statement[]): Record<number, number[]> => {
  const line = new Map(stmts.map((s) => [s.id, s.line]))
  return Object.fromEntries(stmts.map((s) => [s.line, s.deps.map((d) => line.get(d) ?? -1)]))
}

describe('las sentencias de primer nivel', () => {
  const SOURCE =
    'import numpy as np\n\ndef f(a):\n    b = a + 1\n    return b\n\nx = f(1)\nfor i in range(3):\n    x += i\n'

  it('son las que no están dentro de otra, en el orden del archivo', () => {
    const { stmts } = parse(SOURCE)
    expect(stmts.map((s) => s.line)).toEqual([1, 3, 7, 8])
  })

  it('cada una lleva su texto entero, con lo que contiene', () => {
    const { stmts } = parse(SOURCE)
    expect(stmts[1]?.code).toBe('def f(a):\n    b = a + 1\n    return b')
    expect(stmts[3]?.code).toBe('for i in range(3):\n    x += i')
  })

  it('un nodo de dentro pertenece a la de primer nivel que lo envuelve', () => {
    const { program } = parse(SOURCE)
    const top = topLevelOf(program)
    const inner = program.nodes.find((n) => n.line === 9)
    const loop = program.nodes.find((n) => n.line === 8)
    expect(inner && top.get(inner.id)).toBe(loop?.id)
  })

  it('el hash cambia con el texto y solo con él', () => {
    const a = parse('x = 1\n').stmts[0]
    const b = parse('x = 1\n').stmts[0]
    const c = parse('x = 2\n').stmts[0]
    expect(a?.hash).toBe(b?.hash)
    expect(a?.hash).not.toBe(c?.hash)
  })
})

describe('de qué depende cada una', () => {
  it('lo que lee, y los imports que usa', () => {
    const { stmts } = parse('import numpy as np\nx = 1\ny = np.zeros(x)\nz = 5\n')
    expect(depsByLine(stmts)).toEqual({ 1: [], 2: [], 3: [1, 2], 4: [] })
  })

  it('una función depende de lo global que lee, y quien la llama, de ella', () => {
    const { stmts } = parse('k = 3\n\ndef f():\n    return k\n\nr = f()\n')
    expect(depsByLine(stmts)).toEqual({ 1: [], 3: [1], 6: [3] })
  })

  it('cada nombre de un resultado múltiple cuelga de su sentencia', () => {
    const { stmts } = parse('a, b = f()\nprint(b)\n')
    expect(depsByLine(stmts)[2]).toEqual([1])
  })

  it('quien lee un valor depende también de lo que lo mutó antes: model.fit', () => {
    const { stmts } = parse(
      'model = Modelo()\nmodel.fit(datos)\nextra = 1\npred = model.predict(datos)\n',
    )
    const deps = depsByLine(stmts)
    // `fit` lee `model`; `predict` necesita que `fit` ya haya corrido.
    expect(deps[2]).toEqual([1])
    expect(deps[4]).toEqual([1, 2])
    expect(deps[3]).toEqual([])
  })

  it('un mutador posterior no afecta a quien leyó antes', () => {
    const { stmts } = parse('xs = []\nn = len(xs)\nxs.append(1)\n')
    expect(depsByLine(stmts)[2]).toEqual([1])
  })
})

describe('qué está al día', () => {
  const SOURCE = 'a = 1\nb = a + 1\nc = b + 1\nd = 5\n'
  const ran = (stmts: Statement[], only: number[] = [0, 1, 2, 3]): Map<string, Ran> =>
    new Map(
      stmts.flatMap((s, i) =>
        only.includes(i) ? [[s.id, { hash: s.hash, seq: i + 1, ok: true }]] : [],
      ),
    )

  it('nada ejecutado: nunca', () => {
    const { stmts } = parse(SOURCE)
    const state = freshness(stmts, new Map())
    expect([...state.values()]).toEqual(['never', 'never', 'never', 'never'])
  })

  it('todo ejecutado en orden: al día', () => {
    const { stmts } = parse(SOURCE)
    expect([...freshness(stmts, ran(stmts)).values()]).toEqual(['fresh', 'fresh', 'fresh', 'fresh'])
  })

  it('editar una sentencia deja como desactualizado lo que la usa, y solo eso', () => {
    const before = parse(SOURCE)
    const records = ran(before.stmts)
    const after = parse('a = 2\nb = a + 1\nc = b + 1\nd = 5\n')
    const kept = reconcile(records, before.stmts, after.stmts)
    const state = freshness(after.stmts, kept)
    expect([...state.values()]).toEqual(['never', 'stale', 'stale', 'fresh'])
  })

  it('volver a ejecutar una dependencia deja atrás a quien ya se había ejecutado', () => {
    const { stmts } = parse(SOURCE)
    const records = ran(stmts)
    // `a` se ejecuta otra vez, después de `b` y `c`.
    const first = stmts[0]
    if (first) records.set(first.id, { hash: first.hash, seq: 9, ok: true })
    expect([...freshness(stmts, records).values()]).toEqual(['fresh', 'stale', 'stale', 'fresh'])
  })

  it('una ejecución que falló se queda como error hasta que algo cambie', () => {
    const { stmts } = parse(SOURCE)
    const records = ran(stmts)
    const second = stmts[1]
    if (second) records.set(second.id, { hash: second.hash, seq: 2, ok: false })
    const state = freshness(stmts, records)
    expect(state.get(second?.id ?? '')).toBe('error')
    // Lo que lee de una sentencia con error no está al día.
    expect(state.get(stmts[2]?.id ?? '')).toBe('stale')
  })
})

describe('qué ejecutar al pedir un nodo', () => {
  const SOURCE = 'a = 1\nb = a + 1\nc = b + 1\nd = 5\ne = c + d\n'

  it('lo pedido y, antes, lo que necesita y no está al día', () => {
    const { stmts } = parse(SOURCE)
    const plan = planRun(stmts, [stmts[4]?.id ?? ''], freshness(stmts, new Map()))
    expect(plan).toEqual(stmts.map((s) => s.id))
  })

  it('lo que ya está al día no se repite; lo pedido, sí', () => {
    const { stmts } = parse(SOURCE)
    const records = new Map<string, Ran>(
      stmts.slice(0, 4).map((s, i) => [s.id, { hash: s.hash, seq: i + 1, ok: true }]),
    )
    const state = freshness(stmts, records)
    expect(planRun(stmts, [stmts[4]?.id ?? ''], state)).toEqual([stmts[4]?.id])
    // Pedir uno que ya está al día lo ejecuta igual: se pidió.
    expect(planRun(stmts, [stmts[1]?.id ?? ''], state)).toEqual([stmts[1]?.id])
  })

  it('lo desactualizado se trae aunque esté en medio', () => {
    const before = parse(SOURCE)
    const records = new Map<string, Ran>(
      before.stmts.map((s, i) => [s.id, { hash: s.hash, seq: i + 1, ok: true }]),
    )
    const after = parse('a = 9\nb = a + 1\nc = b + 1\nd = 5\ne = c + d\n')
    const state = freshness(after.stmts, reconcile(records, before.stmts, after.stmts))
    const ids = after.stmts.map((s) => s.id)
    // Pedir `e`: hace falta `a` (cambió), `b` y `c` (dependen de ella); `d` sigue al día.
    expect(planRun(after.stmts, [ids[4] ?? ''], state)).toEqual([ids[0], ids[1], ids[2], ids[4]])
  })

  it('ejecutar todo es todo, en orden', () => {
    const { stmts } = parse(SOURCE)
    expect(planAll(stmts)).toEqual(stmts.map((s) => s.id))
  })
})

describe('los registros siguen a su sentencia', () => {
  it('insertar una línea encima mueve los ids pero no los resultados', () => {
    const before = parse('a = 1\nb = a + 1\n')
    const records = new Map<string, Ran>(
      before.stmts.map((s, i) => [s.id, { hash: s.hash, seq: i + 1, ok: true }]),
    )
    const after = parse('import os\na = 1\nb = a + 1\n')
    const kept = reconcile(records, before.stmts, after.stmts)
    expect(kept.size).toBe(2)
    const state = freshness(after.stmts, kept)
    expect([...state.values()]).toEqual(['never', 'fresh', 'fresh'])
  })

  it('con el mismo texto repetido, cada uno conserva el suyo en orden', () => {
    const before = parse('x = 0\nx = 0\n')
    const records = new Map<string, Ran & { tag: string }>(
      before.stmts.map((s, i) => [s.id, { hash: s.hash, seq: i + 1, ok: true, tag: `r${i}` }]),
    )
    const kept = reconcile(records, before.stmts, before.stmts)
    expect([...kept.values()].map((r) => r.tag)).toEqual(['r0', 'r1'])
  })
})

describe('la línea de un fallo', () => {
  it('línea del archivo = donde empieza la sentencia + línea del fragmento − 1', () => {
    expect(fileLine(10, 1)).toBe(10)
    expect(fileLine(10, 3)).toBe(12)
    expect(fileLine(10, null)).toBeNull()
  })
})
