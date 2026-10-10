import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { entryOf, idleness, launchCode, looksInert, withLaunch } from '../src/gist/entry.ts'
import { runSummary } from '../src/gist/gist.ts'
import { localDecider } from '../src/jev/local.ts'
import { codeSystem, judgeEntry, planSystem } from '../src/jev/plain.ts'
import { Kernel } from '../src/kernel.ts'

/**
 * Que el programa se vea funcionar. Quien pide «un algoritmo genético» y recibe siete funciones que nadie
 * llama no ha recibido nada que pueda ver: aquí se comprueba que eso se reconoce (y no se da por «terminó
 * bien»), que se sabe cuál es la función que lo arranca, y que arrancarlo deja un programa que enseña algo.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0
const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, `fixtures/arch/${name}.py`), 'utf8').replace(/\r\n/g, '\n')

let parse: (source: string) => Program
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
}, 30_000)

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

/** El algoritmo genético tal como se construyó en la prueba real: siete funciones y ninguna llamada. */
const GENETICO = fixture('genetico')

describe('quién arranca el programa', () => {
  it('de las funciones a las que nadie llama, la que llega a más', () => {
    const { entry, tied } = entryOf(parse(GENETICO))
    expect(entry?.name).toBe('algoritmo_genetico')
    expect(tied.map((fact) => fact.name)).toEqual(['algoritmo_genetico'])
  })

  it('si varias empatan, no se adivina: se ofrecen todas, y elige el JEV', async () => {
    const source = lines(
      'def saludar(nombre):',
      '    return "hola " + nombre',
      '',
      'def despedir(nombre):',
      '    return "adiós " + nombre',
    )
    const { entry, tied } = entryOf(parse(source))
    expect(entry).toBeNull()
    expect(tied.map((fact) => fact.name)).toEqual(['saludar', 'despedir'])
    const jev = {
      id: 'grabado',
      decide: () =>
        Promise.resolve({
          ms: 1,
          answers: { arranque: { type: 'choice' as const, choice: 'f1', confidence: 0.9 } },
        }),
    }
    expect(await judgeEntry(jev, ['saludar', 'despedir'])).toBe(1)
    // El motor local no lo sabe: decide quien pregunta.
    expect(await judgeEntry(localDecider(), ['saludar', 'despedir'])).toBeNull()
    expect(await judgeEntry(localDecider(), ['sola'])).toBe(0)
  })

  it('una función a la que ya se llama desde el programa no es un arranque pendiente', () => {
    const source = lines('def jugar():', '    print("juego")', '', 'jugar()')
    expect(entryOf(parse(source))).toEqual({ entry: null, tied: [] })
  })
})

describe('un programa que no haría nada, mirando solo su texto', () => {
  it('define funciones y desde arriba no llama a ninguna ni enseña nada', () => {
    expect(looksInert(parse(GENETICO))).toBe(true)
  })

  it('si arranca algo, enseña algo o no tiene funciones, no', () => {
    expect(looksInert(parse(withLaunch(GENETICO, 'algoritmo_genetico(20, 50)', true)))).toBe(false)
    expect(looksInert(parse(fixture('gastos')))).toBe(false)
    expect(looksInert(parse(fixture('informe')))).toBe(false)
    expect(looksInert(parse('a = 1\nb = a + 1\n'))).toBe(false)
    expect(looksInert(parse('def f():\n    return 1\n\nprint("hola")\n'))).toBe(false)
  })
})

describe('la etapa de arranque', () => {
  it('llama con el ejemplo y enseña lo que da; si no devuelve nada, basta con llamar', () => {
    expect(launchCode('algoritmo_genetico(20, 50)', true)).toBe(
      lines(
        '# Arrancar: prueba con un ejemplo',
        'resultado = algoritmo_genetico(20, 50)',
        'print("Resultado:", resultado)',
      ).trimEnd(),
    )
    expect(launchCode('jugar()', false)).toBe('# Arrancar: prueba con un ejemplo\njugar()')
  })

  it('va al final, tras una línea en blanco, y respeta los saltos de línea del archivo', () => {
    const windows = 'def f():\r\n    return 1\r\n\r\n\r\n'
    expect(withLaunch(windows, 'f()', true)).toBe(
      'def f():\r\n    return 1\r\n\r\n# Arrancar: prueba con un ejemplo\r\nresultado = f()\r\nprint("Resultado:", resultado)\r\n',
    )
  })
})

describe('lo que se le pide a la IA', () => {
  it('un programa entero termina arrancando y enseñando su resultado', () => {
    expect(planSystem(false)).toMatch(/ÚLTIMA parte lo pone en marcha/)
    expect(codeSystem(false)).toMatch(/programa entero con plan/)
    // Para una pieza suelta sigue valiendo: sin ejemplos ni `print` que nadie pidió.
    expect(codeSystem(false)).toMatch(/No añadas ejemplos de uso/)
  })
})

describe.skipIf(!available)('al ejecutarlo de verdad', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  it('el genético de la prueba termina sin error y sin hacer nada: inerte, no «terminó bien»', async () => {
    const trace = await kernel.trace(GENETICO)
    expect(trace.error).toBeNull()
    expect(runSummary(trace).ended).toBe('done')
    expect(idleness(parse(GENETICO), trace)).toBe('inert')
  })

  it('con su etapa de arranque, enseña un resultado', async () => {
    const launched = withLaunch(GENETICO, 'algoritmo_genetico(12, 30)', true)
    // Son muchos más pasos de los que se graban: se deja de grabar y el programa acaba, para ver qué da.
    const trace = await kernel.trace(launched, 20_000, false, true, { seed: 7, finish: true })
    expect(trace.error).toBeNull()
    expect(trace).toMatchObject({ truncated: true, finished: true })
    expect(trace.output).toMatch(/^Resultado: .{10}\n$/)
    expect(runSummary(trace).ended).toBe('done')
    expect(idleness(parse(launched), trace)).toBeNull()
    // Sin eso, se corta y no se llega a saber nada.
    const cut = await kernel.trace(launched, 20_000, false, true, { seed: 7 })
    expect(cut).toMatchObject({ truncated: true, output: '' })
    expect(cut.finished).toBeUndefined()
    expect(runSummary(cut).ended).toBe('cut')
  })

  it('un programa que no acaba nunca sí se corta, aunque se le deje seguir', async () => {
    const forever = lines('n = 0', 'while True:', '    n += 1')
    const trace = await kernel.trace(forever, 500, false, true, { finish: 0.3 })
    expect(trace.truncated).toBe(true)
    expect(trace.finished).toBeUndefined()
    expect(runSummary(trace).ended).toBe('cut')
  })

  it('un programa que trabaja pero no enseña nada es mudo', async () => {
    const source = lines('def doble(n):', '    return n * 2', '', 'total = doble(4)')
    expect(idleness(parse(source), await kernel.trace(source))).toBe('mute')
  })

  it('lo que enseña algo, o lo que solo son unas variables, no se toca', async () => {
    for (const name of ['informe', 'juego', 'abanico']) {
      const source = fixture(name)
      expect(idleness(parse(source), await kernel.trace(source))).toBeNull()
    }
    const plain = 'a = 1\nb = a + 1\n'
    expect(idleness(parse(plain), await kernel.trace(plain))).toBeNull()
  })
})
