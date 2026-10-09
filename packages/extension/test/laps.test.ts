import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { gistsOf } from '../src/gist/gist.ts'
import { bestLaps, loopsIn, targetsOf, type LoopFacts } from '../src/gist/laps.ts'
import { showValue } from '../src/gist/value.ts'
import { Kernel } from '../src/kernel.ts'

/**
 * «Cómo funciona» un bucle: de una vez que se ejecutó de verdad, vuelta a vuelta. Qué tomó cada vuelta, cómo
 * cambió lo que el bucle va llevando, y por qué acabó.
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
const loopAt = (program: Program, line: number): LoopFacts => {
  const found = loopsIn(program).find((loop) => loop.line === line)
  if (!found) throw new Error(`no hay bucle en la línea ${line}`)
  return found
}

describe('los bucles del programa', () => {
  it('lee la cabecera de un for y de un while', () => {
    const program = parse(
      lines(
        'total = 0',
        'for i, x in enumerate([3, 4]):',
        '    total += x',
        'n = 3',
        'while n > 0:',
        '    n -= 1',
      ),
    )
    const [first, second] = loopsIn(program)
    expect(first).toMatchObject({ kind: 'for', head: 'for i, x in enumerate([3, 4])' })
    expect(first?.targets).toEqual(['i', 'x'])
    expect(second).toMatchObject({ kind: 'while', test: 'n > 0', targets: [] })
  })

  it('sabe qué nombres toma un for', () => {
    expect(targetsOf('x')).toEqual(['x'])
    expect(targetsOf('(a, b)')).toEqual(['a', 'b'])
  })

  it('marca los break y continue del propio bucle, no los de uno de dentro', () => {
    const program = parse(
      lines(
        'for x in [1, 2]:',
        '    if x == 2:',
        '        break',
        '    for y in [1]:',
        '        continue',
      ),
    )
    const outer = loopAt(program, 1)
    expect(outer.breaks).toEqual([2])
    expect(outer.continues).toEqual([])
    expect(loopAt(program, 4).continues).toEqual([1])
  })
})

describe.skipIf(!available)('las vueltas: lo que pasó al ejecutarlo de verdad', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  it('cuenta cada vuelta: el elemento que entra y cómo cambia lo que el bucle lleva', async () => {
    const source = lines(
      'total = 0',
      'for x in [1, 2, 3]:',
      '    total = total + x',
      'print(total)',
    )
    const program = parse(source)
    const laps = bestLaps(await kernel.trace(source), loopAt(program, 2))
    expect(laps?.total).toBe(3)
    expect(laps?.ended).toBe('done')
    expect(laps?.carried.map((c) => [c.name, showValue(c.value)])).toEqual([['total', '0']])
    expect(
      laps?.laps.map((lap) => showValue(lap.takes[0]?.value ?? { kind: 'opaque', text: '' })),
    ).toEqual(['1', '2', '3'])
    expect(
      laps?.laps.map((lap) => showValue(lap.leaves[0]?.value ?? { kind: 'opaque', text: '' })),
    ).toEqual(['1', '3', '6'])
  })

  it('un while: acaba cuando la condición deja de cumplirse', async () => {
    const source = lines('n = 3', 'while n > 0:', '    print(n)', '    n -= 1')
    const laps = bestLaps(await kernel.trace(source), loopAt(parse(source), 2))
    expect(laps?.total).toBe(3)
    expect(laps?.ended).toBe('done')
    expect(laps?.laps.map((lap) => lap.printed)).toEqual(['3\n', '2\n', '1\n'])
  })

  it('si el bucle es lo último de una función, acaba igual: sin una vuelta de más', async () => {
    const source = lines(
      'def mostrar(xs):',
      '    for x in xs:',
      '        print(x)',
      '',
      '',
      'def cuenta(n):',
      '    while n > 0:',
      '        n -= 1',
      '',
      '',
      'mostrar([1, 2, 3])',
      'cuenta(3)',
    )
    const program = parse(source)
    const trace = await kernel.trace(source)
    const each = bestLaps(trace, loopAt(program, 2))
    expect(each?.total).toBe(3)
    expect(each?.ended).toBe('done')
    const until = bestLaps(trace, loopAt(program, 7))
    expect(until?.total).toBe(3)
    expect(until?.ended).toBe('done')
  })

  it('un return desde dentro sí es salir de la función', async () => {
    const source = lines(
      'def primero_par(xs):',
      '    for x in xs:',
      '        if x % 2 == 0:',
      '            return x',
      '',
      '',
      'primero_par([1, 3, 4, 5])',
    )
    const laps = bestLaps(await kernel.trace(source), loopAt(parse(source), 2))
    expect(laps?.total).toBe(3)
    expect(laps?.ended).toBe('return')
  })

  it('un error que atrapa un try de dentro no es un fallo del bucle', async () => {
    const source = lines(
      'def sumar(textos):',
      '    total = 0',
      '    for texto in textos:',
      '        try:',
      '            total += int(texto)',
      '        except ValueError:',
      '            total += 0',
      '',
      '',
      'sumar(["1", "a"])',
    )
    const laps = bestLaps(await kernel.trace(source), loopAt(parse(source), 3))
    expect(laps?.total).toBe(2)
    expect(laps?.ended).toBe('done')
    expect(laps?.error).toBeUndefined()
  })

  it('si el programa se queda esperando un dato dentro del bucle, no «salió con break»', async () => {
    const source = lines(
      'while True:',
      '    intento = int(input("Adivina: "))',
      '    if intento == 7:',
      '        break',
      '    print("No")',
    )
    const trace = await kernel.trace(source, 20_000, false, false, { inputs: ['1', '2'] })
    const laps = bestLaps(trace, loopAt(parse(source), 1))
    expect(laps?.ended).toBe('cut')
    // Y con el dato que lo acierta, sí sale con break.
    const won = await kernel.trace(source, 20_000, false, false, { inputs: ['1', '7'] })
    expect(bestLaps(won, loopAt(parse(source), 1))?.ended).toBe('break')
  })

  it('un break: la vuelta en la que sale', async () => {
    const source = lines(
      'for x in [5, 7, 8, 9]:',
      '    if x % 2 == 0:',
      '        print("par", x)',
      '        break',
    )
    const laps = bestLaps(await kernel.trace(source), loopAt(parse(source), 1))
    expect(laps?.total).toBe(3)
    expect(laps?.ended).toBe('break')
    expect(laps?.laps.at(-1)?.exit).toBe('break')
  })

  it('con muchas vueltas, enseña las primeras y la última', async () => {
    const source = lines('s = 0', 'for i in range(20):', '    s += i')
    const laps = bestLaps(await kernel.trace(source), loopAt(parse(source), 2))
    expect(laps?.total).toBe(20)
    expect(laps?.laps).toHaveLength(7)
    expect(laps?.skipped).toEqual({ count: 13, at: 6 })
    expect(showValue(laps?.laps.at(-1)?.takes[0]?.value ?? { kind: 'opaque', text: '' })).toBe('19')
  })

  it('dentro de una función, y llega como tarjeta junto a las de las funciones', async () => {
    const source = lines(
      'def suma(xs):',
      '    t = 0',
      '    for x in xs:',
      '        t += x',
      '    return t',
      '',
      'print(suma([2, 4]))',
    )
    const program = parse(source)
    const gists = gistsOf(program, await kernel.trace(source))
    const loop = gists.find((gist) => gist.block === 'loop')
    expect(loop?.name).toBe('for x in xs')
    expect(loop?.laps?.total).toBe(2)
    expect(gists.some((gist) => gist.name === 'suma')).toBe(true)
  })

  it('un bucle que no se ejecutó no lleva tarjeta', async () => {
    const source = lines('def nunca():', '    for x in [1]:', '        print(x)')
    const gists = gistsOf(parse(source), await kernel.trace(source))
    expect(gists.some((gist) => gist.block === 'loop')).toBe(false)
  })
})
