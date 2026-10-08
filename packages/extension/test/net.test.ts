import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { gistsOf } from '../src/gist/gist.ts'
import { bestNet, triesIn, type TryFacts } from '../src/gist/net.ts'
import { showValue } from '../src/gist/value.ts'
import { Kernel } from '../src/kernel.ts'
import { tryScene } from '../webview/src/gisting.ts'

/**
 * «Cómo funciona» un `try`: la red de seguridad, de una vez que se ejecutó de verdad. Qué se intentó, si saltó
 * un error y dónde, qué `except` lo atrapó y qué hizo, o que no saltó nunca.
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
const tryAt = (program: Program, line: number): TryFacts => {
  const found = triesIn(program).find((facts) => facts.line === line)
  if (!found) throw new Error(`no hay try en la línea ${line}`)
  return found
}

const CONVERTIR = lines(
  'def convertir(texto):',
  '    try:',
  '        n = int(texto)',
  '    except ValueError as e:',
  '        print("no es un número")',
  '        n = 0',
  '    else:',
  '        print("bien")',
  '    finally:',
  '        print("fin")',
  '    return n',
  '',
  'convertir("3")',
  'convertir("hola")',
)

describe('los try del programa', () => {
  it('lee sus cláusulas, con el nombre que recibe el error', () => {
    const facts = tryAt(parse(CONVERTIR), 2)
    expect(facts.bodyEnd).toBe(3)
    expect(
      facts.clauses.map((clause) => [clause.kind, clause.head, clause.line, clause.lineEnd]),
    ).toEqual([
      ['except', 'except ValueError as e', 4, 6],
      ['else', 'else', 7, 8],
      ['finally', 'finally', 9, 10],
    ])
    expect(facts.clauses[0]?.alias).toBe('e')
  })
})

describe.skipIf(!available)('la red: lo que pasó al ejecutarlo de verdad', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  it('enseña la vez que cayó en la red: dónde saltó, quién lo atrapó y qué hizo', async () => {
    const program = parse(CONVERTIR)
    const net = bestNet(await kernel.trace(CONVERTIR), tryAt(program, 2))
    expect(net?.outcome).toBe('caught')
    expect(net?.error).toMatch(/^ValueError: invalid literal/)
    expect(net?.tally).toEqual({ ok: 1, caught: 1, escaped: 0 })
    const [attempt, handler, otherwise, last] = net?.parts ?? []
    expect(attempt).toMatchObject({ kind: 'try', state: 'raised', at: 'n = int(texto)' })
    expect(handler).toMatchObject({ kind: 'except', state: 'caught', printed: 'no es un número\n' })
    expect(handler?.leaves?.map((leave) => [leave.name, showValue(leave.value)])).toEqual([
      ['n', '0'],
    ])
    expect(otherwise).toMatchObject({ kind: 'else', state: 'skipped' })
    expect(last).toMatchObject({ kind: 'finally', state: 'ran', printed: 'fin\n' })
  })

  it('si nunca saltó, lo dice: la red no hizo falta', async () => {
    const source = lines(
      'try:',
      '    x = 10 / 2',
      'except ZeroDivisionError:',
      '    x = 0',
      'print(x)',
    )
    const net = bestNet(await kernel.trace(source), tryAt(parse(source), 1))
    expect(net?.outcome).toBe('ok')
    expect(net?.parts.map((part) => part.state)).toEqual(['ran', 'skipped'])
    const scene = tryScene({
      id: 't',
      name: 'try · except ZeroDivisionError',
      owner: null,
      hash: '',
      title: null,
      status: 'ok',
      sample: null,
      block: 'try',
      ...(net ? { net } : {}),
    })
    const piece = scene?.lanes[0]?.[0]
    expect(piece?.type === 'net' && piece.fall).toBeFalsy()
    expect(piece?.type === 'net' && piece.end).toBe('No saltó ningún error: la red no hizo falta.')
  })

  it('un error de otro tipo atraviesa la red y se escapa', async () => {
    const source = lines(
      'def f():',
      '    try:',
      '        return [1][5]',
      '    except KeyError:',
      '        return 0',
      '',
      'try:',
      '    f()',
      'except IndexError:',
      '    print("fuera")',
    )
    const program = parse(source)
    const trace = await kernel.trace(source)
    const inner = bestNet(trace, tryAt(program, 2))
    expect(inner?.outcome).toBe('escaped')
    expect(inner?.parts[1]).toMatchObject({ kind: 'except', state: 'skipped' })
    // El de fuera sí lo atrapa: el error saltó en la llamada.
    const outer = bestNet(trace, tryAt(program, 7))
    expect(outer?.outcome).toBe('caught')
    expect(outer?.parts[0]).toMatchObject({ state: 'raised', at: 'f()' })
  })

  it('dentro de un bucle: cuenta cómo acabó cada vez y llega como tarjeta', async () => {
    const source = lines(
      'total = 0',
      'for t in ["1", "x", "2", "y"]:',
      '    try:',
      '        total += int(t)',
      '    except ValueError:',
      '        pass',
      'print(total)',
    )
    const program = parse(source)
    const gists = gistsOf(program, await kernel.trace(source))
    const card = gists.find((gist) => gist.block === 'try')
    expect(card?.name).toBe('try · except ValueError')
    expect(card?.net?.tally).toEqual({ ok: 2, caught: 2, escaped: 0 })
    const scene = card ? tryScene(card) : null
    const piece = scene?.lanes[0]?.[0]
    expect(piece?.type === 'net' && piece.end).toBe(
      'De 4 veces: 2 sin errores, 2 cayeron en la red.',
    )
    expect(piece?.type === 'net' && piece.fall?.to).toBe(1)
  })

  it('un try que no se ejecutó no lleva tarjeta', async () => {
    const source = lines(
      'def nunca():',
      '    try:',
      '        pass',
      '    except Exception:',
      '        pass',
    )
    const gists = gistsOf(parse(source), await kernel.trace(source))
    expect(gists.some((gist) => gist.block === 'try')).toBe(false)
  })
})
