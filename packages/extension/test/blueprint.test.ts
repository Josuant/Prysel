import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { bestLife, classesIn, type ClassFacts, type Life } from '../src/gist/blueprint.ts'
import { gistsOf } from '../src/gist/gist.ts'
import { showValue, type Value } from '../src/gist/value.ts'
import { Kernel } from '../src/kernel.ts'
import { classScene } from '../webview/src/gisting.ts'

/**
 * «Cómo funciona» una clase: el plano y la vida de uno de sus objetos, de una vez que se ejecutó de verdad.
 * Cada llamada a un método desde fuera, cómo quedaron los campos y qué devolvió.
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
const classOf = (program: Program, name: string): ClassFacts => {
  const found = classesIn(program).find((facts) => facts.name === name)
  if (!found) throw new Error(`no hay clase ${name}`)
  return found
}
const shown = (value: Value | undefined) => (value ? showValue(value) : '—')
const table = (life: Life | null) =>
  life?.visits.map((visit) => [visit.call, ...visit.fields.map(shown)]) ?? []

const CUENTA = lines(
  'class Cuenta:',
  '    def __init__(self, dueño):',
  '        self.dueño = dueño',
  '        self.saldo = 0',
  '',
  '    def ingresar(self, cantidad):',
  '        self.saldo += cantidad',
  '        self._apuntar()',
  '',
  '    def _apuntar(self):',
  '        self.ultimo = self.saldo',
  '',
  '    def puede(self, cantidad):',
  '        return self.saldo >= cantidad',
  '',
  'c = Cuenta("ana")',
  'c.ingresar(50)',
  'c.ingresar(20)',
  'print(c.puede(100))',
  'otra = Cuenta("luis")',
)

describe('las clases del programa', () => {
  it('lee sus métodos', () => {
    const facts = classOf(parse(CUENTA), 'Cuenta')
    expect(facts.methods.map((method) => method.name)).toEqual([
      '__init__',
      'ingresar',
      '_apuntar',
      'puede',
    ])
  })
})

describe.skipIf(!available)('la vida de un objeto: lo que pasó al ejecutarlo de verdad', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  it('cada llamada desde fuera, con los campos tras ella y lo que cambió', async () => {
    const program = parse(CUENTA)
    const life = bestLife(await kernel.trace(CUENTA), classOf(program, 'Cuenta'))
    expect(life?.objects).toBe(2)
    expect(life?.total).toBe(4)
    expect(life?.fields).toEqual(['dueño', 'saldo', 'ultimo'])
    // La llamada a `_apuntar` desde `ingresar` no es una fila: es parte de `ingresar`.
    expect(table(life)).toEqual([
      ["Cuenta('ana')", "'ana'", '0', '—'],
      ['ingresar(50)', "'ana'", '50', '50'],
      ['ingresar(20)', "'ana'", '70', '70'],
      ['puede(100)', "'ana'", '70', '70'],
    ])
    expect(life?.visits.map((visit) => visit.changed)).toEqual([
      [true, true, false],
      [false, true, true],
      [false, true, true],
      [false, false, false],
    ])
    expect(shown(life?.visits[3]?.returned)).toBe('False')
  })

  it('llega como tarjeta, con su escena de tabla', async () => {
    const gists = gistsOf(parse(CUENTA), await kernel.trace(CUENTA))
    const card = gists.find((gist) => gist.block === 'class')
    expect(card?.name).toBe('Cuenta')
    const scene = card ? classScene(card) : null
    expect(scene?.title).toBe('El plano de Cuenta: 2 métodos en uso, 4 llamadas')
    const piece = scene?.lanes[0]?.[0]
    expect(piece?.type === 'laps' && piece.columns).toEqual([
      'llamada',
      'dueño',
      'saldo',
      'ultimo',
      'devuelve',
    ])
    expect(piece?.type === 'laps' && piece.end).toBe('2 objetos Cuenta: este es el que más se usó.')
  })

  it('un método que falla lo dice en su fila', async () => {
    const source = lines(
      'class Pila:',
      '    def __init__(self):',
      '        self.datos = []',
      '    def poner(self, x):',
      '        self.datos.append(x)',
      '    def sacar(self):',
      '        return self.datos.pop()',
      '',
      'p = Pila()',
      'p.poner(1)',
      'p.sacar()',
      'try:',
      '    p.sacar()',
      'except IndexError:',
      '    pass',
    )
    const life = bestLife(await kernel.trace(source), classOf(parse(source), 'Pila'))
    expect(table(life)).toEqual([
      ['Pila()', '[]'],
      ['poner(1)', '[1]'],
      ['sacar()', '[]'],
      ['sacar()', '[]'],
    ])
    expect(shown(life?.visits[2]?.returned)).toBe('1')
    expect(life?.visits[3]?.error).toMatch(/^IndexError/)
  })

  it('con muchas llamadas, enseña las primeras y la última', async () => {
    const source = lines(
      'class Contador:',
      '    def __init__(self):',
      '        self.n = 0',
      '    def sube(self):',
      '        self.n += 1',
      '',
      'c = Contador()',
      'for _ in range(12):',
      '    c.sube()',
    )
    const life = bestLife(await kernel.trace(source), classOf(parse(source), 'Contador'))
    expect(life?.total).toBe(13)
    expect(life?.visits).toHaveLength(7)
    expect(life?.skipped).toEqual({ count: 6, at: 6 })
    expect(shown(life?.visits.at(-1)?.fields[0])).toBe('12')
  })

  it('una clase sin objetos no lleva tarjeta', async () => {
    const source = lines('class Nada:', '    def f(self):', '        return 1', 'print("hola")')
    const gists = gistsOf(parse(source), await kernel.trace(source))
    expect(gists.some((gist) => gist.block === 'class')).toBe(false)
  })
})
