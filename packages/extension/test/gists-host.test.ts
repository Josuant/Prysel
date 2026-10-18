import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { Gists } from '../src/gists.ts'
import type { RunSummary } from '../src/gist/gist.ts'
import { localDecider } from '../src/jev/local.ts'
import { Kernel } from '../src/kernel.ts'

/**
 * El motor que mira un programa (lo que hace cada función, cómo le fue al ejecutarlo, cómo avanza) es el
 * mismo en la web y en VS Code. En VS Code el programa corre en el equipo de verdad: se ejecuta solo en
 * **modo seguro**, y lo que no lo cumple no se ejecuta: se dice, para que lo ejecute quien lo usa.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0
const NL = String.fromCharCode(10)
const lines = (...rows: string[]) => rows.join(NL) + NL

let parse: (source: string) => Program
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
}, 30_000)

describe.skipIf(!available)('el motor de «qué hace», en modo seguro', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  /** Mira un programa como lo hace VS Code (en modo seguro) y devuelve lo que se mandaría al lienzo. */
  const look = (source: string) =>
    new Promise<RunSummary | null>((resolve, reject) => {
      const gists = new Gists({
        version: () => 1,
        text: () => source,
        analyse: () => Promise.resolve(parse(source)),
        trace: (code, inputs, seed = 7, watch) =>
          kernel.trace(code, 20_000, true, true, {
            seed,
            finish: true,
            ...(inputs ? { inputs } : {}),
            ...(watch ? { watch } : {}),
          }),
        provider: () => null,
        decider: () => localDecider(),
        busy: () => false,
        post: (_, __, run) => {
          resolve(run)
        },
      })
      gists.touch()
      setTimeout(() => {
        reject(new Error('no llegó nada'))
      }, 20_000)
    })

  it('un programa que solo calcula se ejecuta solo, como en la web', async () => {
    const run = await look(
      lines(
        'import random',
        '# Tirar',
        'def tirar():',
        '    return random.randint(1, 6)',
        '# Arrancar',
        'print("Sale", tirar())',
      ),
    )
    expect(run?.ended).toBe('done')
    expect(run?.output).toMatch(/^Sale [1-6]/)
  }, 30_000)

  it('uno que puede tocar el equipo no se ejecuta: se dice por qué', async () => {
    const run = await look(
      lines(
        'import os',
        '# Mirar',
        'def cuantos():',
        '    return len(os.listdir("."))',
        'print(cuantos())',
      ),
    )
    // (Esto ya lo ve antes de ejecutar nada, por lo que importa: lo mismo que en la web.)
    expect(run?.ended).toBe('blocked')
    expect(run?.problem).toContain('Puede tocar archivos')
  }, 30_000)

  it('y lo que el modo seguro no admite, tampoco: el motor dice qué y dónde', async () => {
    const run = await look(
      lines(
        'import time',
        '# Esperar',
        'def espera():',
        '    return time.time() > 0',
        'print(espera())',
      ),
    )
    expect(run?.ended).toBe('blocked')
    expect(run?.problem).toContain('«time»')
    expect(run?.problem).toContain('ejecútalo tú')
  }, 30_000)
})

describe.skipIf(!available)('el modo seguro y lo que se teclea', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  it('con respuestas de ejemplo, `input` no lee del equipo: vale', async () => {
    const source = lines('nombre = input("¿Cómo te llamas? ")', 'print("Hola,", nombre)')
    const scripted = await kernel.trace(source, 20_000, true, false, { inputs: ['Ana'] })
    expect(scripted.error).toBeNull()
    expect(scripted.output).toContain('Hola, Ana')
    // Sin ellas, leería de verdad: no se admite.
    const bare = await kernel.trace(source, 20_000, true, false)
    expect(bare.error?.name).toBe('UnsafeCode')
  })
})
