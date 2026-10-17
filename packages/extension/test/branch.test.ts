import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { bestSwitch, conditionsIn, substitute, type ConditionFacts } from '../src/gist/branch.ts'
import { gistsOf } from '../src/gist/gist.ts'
import { Kernel } from '../src/kernel.ts'
import { conditionScene } from '../webview/src/gisting.ts'

/**
 * «Cómo funciona» un `if`: las agujas del tren. Con qué valores se comprobó cada condición, por qué rama siguió
 * cada vez y cuántas veces fue por cada una.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0

let parse: (source: string) => Program
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
}, 30_000)

const lines = (...rows: string[]) => `${rows.join('\n')}\n`
const ifAt = (program: Program, line: number): ConditionFacts => {
  const found = conditionsIn(program).find((facts) => facts.line === line)
  if (!found) throw new Error(`no hay if en la línea ${line}`)
  return found
}

const NOTAS = lines(
  'for nota in [9, 5, 7, 3]:',
  '    if nota >= 9:',
  '        print("sobresaliente")',
  '    elif nota >= 5:',
  '        print("aprobado")',
  '    else:',
  '        print("suspenso")',
  'print("fin")',
)

describe('los if del programa', () => {
  it('lee sus brazos: el if, cada elif y el else, con sus líneas', () => {
    const program = parse(NOTAS)
    expect(conditionsIn(program)).toHaveLength(1)
    const facts = ifAt(program, 2)
    expect(facts.lineEnd).toBe(7)
    expect(facts.arms.map((arm) => [arm.kind, arm.test, arm.line, arm.lineEnd])).toEqual([
      ['if', 'nota >= 9', 2, 3],
      ['elif', 'nota >= 5', 4, 5],
      ['else', null, 6, 7],
    ])
  })

  it('pone los valores en lugar de los nombres, pero no en atributos, llamadas ni textos', () => {
    expect(substitute('n <= 1', { n: 3 })).toBe('3 <= 1')
    expect(substitute('x.n > n and f(n)', { n: 2, x: 'a' })).toBe('x.n > 2 and f(2)')
    expect(substitute('nombre == "n"', { nombre: "'ana'", n: 1 })).toBe('\'ana\' == "n"')
    const xs = { l: [5, 2, 9], n: 3, t: 'list' as const }
    expect(substitute('xs[j] > xs[j + 1]', { xs, j: 0 })).toBe('5 > 2')
    expect(substitute('xs[-1] == x', { xs, x: 9 })).toBe('9 == 9')
    // Un índice que no es sencillo, o fuera de la lista, se queda como está.
    expect(substitute('xs[f(j)] > 0', { xs, j: 0 })).toBe('xs[f(0)] > 0')
    expect(substitute('xs[j + 5] > 0', { xs, j: 0 })).toBe('xs[0 + 5] > 0')
  })
})

describe.skipIf(!available)('las agujas: lo que pasó al ejecutarlo de verdad', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  it('cada visita: con qué valores se comprobó y por qué rama siguió', async () => {
    const program = parse(NOTAS)
    const result = bestSwitch(await kernel.trace(NOTAS), ifAt(program, 2))
    expect(result?.total).toBe(4)
    expect(result?.totals).toEqual([1, 2, 1])
    expect(result?.visits.map((visit) => visit.arm)).toEqual([0, 1, 1, 2])
    expect(result?.visits[1]).toEqual({
      arm: 1,
      tests: ['5 >= 9', '5 >= 5', null],
      verdicts: [false, true, null],
    })
    expect(result?.visits[3]?.verdicts).toEqual([false, false, null])
  })

  it('sin else, una visita que no entra en ninguna rama', async () => {
    const source = lines('x = 0', 'if x > 0:', '    print("positivo")', 'print("fin")')
    const result = bestSwitch(await kernel.trace(source), ifAt(parse(source), 2))
    expect(result?.none).toBe(1)
    expect(result?.visits[0]).toEqual({ arm: -1, tests: ['0 > 0'], verdicts: [false] })
  })

  it('el caso base de una recursión, y llega como tarjeta', async () => {
    const source = lines(
      'def factorial(n):',
      '    if n <= 1:',
      '        return 1',
      '    return n * factorial(n - 1)',
      '',
      'print(factorial(3))',
    )
    const program = parse(source)
    const gists = gistsOf(program, await kernel.trace(source))
    const card = gists.find((gist) => gist.block === 'condition')
    expect(card?.name).toBe('if n <= 1')
    expect(card?.branches?.visits.map((visit) => visit.tests[0])).toEqual([
      '3 <= 1',
      '2 <= 1',
      '1 <= 1',
    ])
    const scene = card ? conditionScene(card) : null
    const piece = scene?.lanes[0]?.[0]
    expect(piece?.type === 'switch' && piece.end).toBe('3 veces: 1 por «si», 2 de largo.')
  })

  it('un if que no se ejecutó no lleva tarjeta', async () => {
    const source = lines('def nunca(x):', '    if x:', '        return 1', 'print(2)')
    const gists = gistsOf(parse(source), await kernel.trace(source))
    expect(gists.some((gist) => gist.block === 'condition')).toBe(false)
  })
})
