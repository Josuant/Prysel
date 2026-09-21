import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { Kernel, type RunResult, type Summary } from '../src/kernel.ts'

/**
 * La pregunta de la prueba: ¿se puede ejecutar un programa de Prysel **nodo a nodo** y traer, para
 * cada chip, su valor con tipo y forma? Aquí se recorre el grafo en orden, se ejecuta el texto de cada
 * sentencia de primer nivel en el motor y se recoge lo que define.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const has = (code: string) => spawnSync(python, ['-c', code], { stdio: 'ignore' }).status === 0
const available = has('import numpy')

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

const SOURCE = `import numpy as np


def kmeans(X, k, iters=10):
    centers = X[:k].copy()
    for _ in range(iters):
        d = np.linalg.norm(X[:, None] - centers[None], axis=2)
        labels = d.argmin(axis=1)
        centers = np.array([X[labels == j].mean(axis=0) for j in range(k)])
    return centers, labels


rng = np.random.default_rng(0)
X = rng.normal(size=(200, 2))
centers, labels = kmeans(X, 3)
n = len(X)
total = 0
for i in range(5):
    total += i
`

interface Step {
  line: number
  code: string
  names: string[]
  result: RunResult
}

describe.skipIf(!available)('ejecutar un programa nodo a nodo', () => {
  let kernel: Kernel
  let program: Program
  const steps: Step[] = []

  beforeAll(async () => {
    const parser = await createPythonParser({
      runtime: wasmDir,
      language: path.join(wasmDir, 'tree-sitter-python.wasm'),
    })
    program = buildProgram(parser.parse(SOURCE), SOURCE)
    kernel = await Kernel.start({ python })
    // Las sentencias de primer nivel, en el orden del archivo: lo que la extensión haría al pulsar «ejecutar todo».
    const top = program.nodes
      .filter((node) => node.range && node.range.owner === undefined)
      .sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0))
    for (const node of top) {
      if (!node.range) continue
      const code = SOURCE.slice(node.range.start, node.range.end)
      const names = node.results ?? (node.provides === undefined ? [] : [node.provides])
      steps.push({ line: node.line, code, names, result: await kernel.run(code, { watch: names }) })
    }
  }, 60_000)

  afterAll(() => kernel.dispose())

  const value = (name: string): Summary | undefined => {
    // El último que lo definió o lo cambió: es el que el lienzo enseña.
    for (const step of [...steps].reverse()) {
      if (step.result.values[name]) return step.result.values[name]
    }
    return undefined
  }

  it('cada sentencia de primer nivel se ejecuta, en orden y sin fallos', () => {
    expect(steps.map((s) => s.line)).toEqual([1, 4, 13, 14, 15, 16, 17, 18])
    expect(steps.filter((s) => !s.result.ok)).toEqual([])
  })

  it('cada chip trae el tipo y la forma de su valor', () => {
    expect(value('X')).toMatchObject({ type: 'ndarray', shape: [200, 2], dtype: 'float64' })
    // Un resultado entre varios: cada nombre con su propio resumen.
    expect(value('centers')).toMatchObject({ type: 'ndarray', shape: [3, 2] })
    expect(value('labels')).toMatchObject({ type: 'ndarray', shape: [200] })
    expect(value('n')).toMatchObject({ type: 'int', repr: '200' })
    expect(value('total')).toMatchObject({ type: 'int', repr: '10' })
  })

  it('un bucle trae el valor final de lo que cambia, sin que el grafo lo diga', () => {
    const loop = steps.find((s) => s.line === 18)
    // El grafo solo conoce la variable del bucle: `total` lo aporta el propio motor.
    expect(loop?.names).toEqual(['i'])
    expect(Object.keys(loop?.result.values ?? {}).sort()).toEqual(['i', 'total'])
  })

  it('una función definida es un valor más, y se puede llamar después', () => {
    const def = steps.find((s) => s.line === 4)
    expect(def?.names).toEqual(['kmeans'])
    expect(def?.result.values['kmeans']).toMatchObject({ type: 'function' })
  })

  it('el fallo de un nodo señala su línea real en el archivo, y lo anterior sigue vivo', async () => {
    const node = program.nodes.find((n) => n.line === 16)
    const code = `n = len(X)\nboom = 1 / (n - n)\nresto = 1`
    const failed = await kernel.run(code)
    expect(failed.error).toMatchObject({ name: 'ZeroDivisionError', line: 2 })
    // La línea dentro del fragmento + la línea donde empieza el nodo = la del archivo.
    expect((node?.line ?? 0) + (failed.error?.line ?? 0) - 1).toBe(17)
    expect((await kernel.run('total')).result?.repr).toBe('10')
  })

  it('un bucle largo enseña su progreso mientras corre', async () => {
    const seen: string[] = []
    const run = await kernel.run(
      'import time\nfor epoch in range(3):\n    print(f"epoch {epoch}")\n    time.sleep(0.1)',
      { onStream: (_, text) => seen.push(text.trim()) },
    )
    expect(run.ok).toBe(true)
    expect(seen.filter(Boolean)).toEqual(['epoch 0', 'epoch 1', 'epoch 2'])
  })
})
