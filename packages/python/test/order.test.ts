import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '../src/index.ts'

/**
 * El orden de ejecución: cada sentencia tras la anterior, y lo que sigue a una decisión saliendo de
 * sus dos caminos. Es lo que la colocación sigue para ordenar el plano.
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

/** El orden como pares «línea → línea», para leerlo de un vistazo. */
function order(source: string): string[] {
  const program = parse(source)
  const line = (id: string) => program.nodes.find((n) => n.id === id)?.line
  return program.edges
    .filter((e) => e.relation === 'sequence')
    .map((e) => `${line(e.from)}→${line(e.to)}`)
}

describe('el orden de las sentencias', () => {
  it('cada una detrás de la anterior', () => {
    expect(order('a = input()\nb = a + 1\nprint(b)\n')).toEqual(['1→2', '2→3'])
  })

  it('una definición no se ejecuta donde se escribe: el orden pasa de largo', () => {
    expect(order('a = input()\ndef f():\n    return 1\nb = a\n')).toEqual(['1→4'])
  })

  it('dentro de una función o un bucle, cada cuerpo lleva el suyo', () => {
    const lines = order('def f(x):\n    a = x\n    b = a\nfor i in r:\n    c = i\n    d = c\n')
    expect(lines).toEqual(expect.arrayContaining(['2→3', '5→6']))
    // Y el bucle no está unido a la definición de arriba.
    expect(lines).not.toContain('1→4')
  })

  it('tras un bucle sigue lo que viene después', () => {
    expect(order('for i in r:\n    a = i\nb = 1\n')).toContain('1→3')
  })
})

describe('el orden alrededor de una decisión', () => {
  it('lo que sigue nace del final de sus dos caminos', () => {
    const lines = order('x = 1\nif x:\n    a = 1\nelse:\n    b = 2\nc = 3\n')
    expect(lines).toEqual(expect.arrayContaining(['1→2', '3→6', '5→6']))
    // La decisión sola no salta al final si tiene un else: los dos caminos pasan por sus ramas.
    expect(lines).not.toContain('2→6')
  })

  it('sin else, la decisión también sigue directamente (el camino en que no se cumple)', () => {
    const lines = order('x = 1\nif x:\n    a = 1\nc = 3\n')
    expect(lines).toEqual(expect.arrayContaining(['2→4', '3→4']))
  })

  it('un camino que salta (return, break) no sigue con lo siguiente', () => {
    const lines = order('def f(x):\n    if x:\n        return 1\n    y = 2\n')
    // Solo sigue el camino en que no se cumple.
    expect(lines).toContain('2→4')
    expect(lines).not.toContain('3→4')
  })

  it('nada sigue a un return', () => {
    expect(order('def f():\n    return 1\n    a = 2\n')).toEqual([])
  })
})
