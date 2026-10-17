import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits } from '@prysel/python/edits'
import type { AiProvider } from '../src/ai/provider.ts'
import type { Decider } from '../src/jev/client.ts'
import { modify, summaryOf, type Shown, type Stagehand } from '../src/jev/director.ts'
import { localDecider } from '../src/jev/local.ts'
import type { Trace } from '../src/trace.ts'
import { missingOf } from '../src/jev/plain.ts'

/**
 * La revisión: cuando al acabar una orden el JEV duda de que se haya hecho todo lo pedido, no se queda en
 * «revísalo». La IA lee el programa contra la orden y dice qué falta; el JEV decide qué de eso se pidió de
 * verdad; y lo que falte se completa, como un cambio más.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => Program
let hasError: (source: string) => boolean
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
  hasError = (source: string) => parser.parse(source).rootNode.hasError
}, 30_000)

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

const ANTES = lines('def total(precios):', '    return sum(precios)')
const MEDIO = lines('def total(precios):', '    return sum(precios)', '', 'precios = [3, 4, 5]')
const ENTERO = lines(
  'def total(precios):',
  '    return sum(precios)',
  '',
  'precios = [3, 4, 5]',
  'print("Total:", total(precios))',
)

/**
 * Lo que daría ejecutar el programa (de mentira): falla si llama a `totl` (un nombre mal escrito); si imprime
 * el total, sale «Total: 12».
 */
function runOf(text: string): Trace {
  const broken = text.includes('totl(')
  return {
    events: [],
    truncated: false,
    error: broken ? { name: 'NameError', message: "name 'totl' is not defined", line: 5 } : null,
    output: !broken && text.includes('print(') ? 'Total: 12\n' : '',
  }
}

function stage(source: string, runs = false) {
  const state = { text: source, shown: [] as Shown[] }
  const host: Stagehand = {
    signal: new AbortController().signal,
    program: () => Promise.resolve(parse(state.text)),
    ...(runs ? { run: () => Promise.resolve(runOf(state.text)) } : {}),
    parses: (code) => !hasError(code),
    write(change) {
      if (change.edits.length > 0) state.text = applyEdits(state.text, change.edits)
      return Promise.resolve(null)
    },
    show(event) {
      state.shown.push(event)
      return Promise.resolve()
    },
    wait: () => Promise.resolve(),
    settle: () => Promise.resolve(),
  }
  return { host, state }
}

/**
 * Una IA de mentira: al reescribir devuelve el siguiente programa de `programs`; al revisar, `review`; si
 * no, una frase.
 */
function ai(
  programs: string[],
  review: string,
): AiProvider & { reviews: number; rewrites: string[]; reviewed: string[] } {
  const queue = [...programs]
  const self = {
    id: 'mentira',
    reviews: 0,
    rewrites: [] as string[],
    reviewed: [] as string[],
    generate(request: { system: string; prompt: string }) {
      if (request.system.includes('revisa un programa')) {
        self.reviews++
        self.reviewed.push(request.prompt)
        return Promise.resolve(review)
      }
      if (request.system.includes('programa ENTERO')) {
        self.rewrites.push(request.prompt)
        return Promise.resolve(queue.shift() ?? '')
      }
      return Promise.resolve('Ahora suma los precios.')
    },
  }
  return self as unknown as AiProvider & { reviews: number; rewrites: string[]; reviewed: string[] }
}

/**
 * Un JEV que duda de que esté todo mientras el programa no imprime el total, y que dice si lo que la revisión
 * echa en falta lo pedía la orden (`asked`).
 */
function jev(asked: boolean, unsure = 0.2): Decider & { missingAsked: number } {
  const local = localDecider()
  const self = {
    id: 'prueba',
    missingAsked: 0,
    async decide(request: Parameters<Decider['decide']>[0]) {
      const result = await local.decide(request)
      const code = (request.state as { codigo?: unknown }).codigo
      if ('cumple' in request.questions) {
        const done = typeof code === 'string' && code.includes('print(')
        result.answers['cumple'] = { type: 'noul', noul: done ? 0.9 : unsure }
      }
      for (const id of Object.keys(request.questions)) {
        if (/^pedia\d+$/.test(id)) {
          self.missingAsked++
          result.answers[id] = { type: 'noul', noul: asked ? 0.9 : 0.1 }
        }
      }
      return result
    },
  }
  return self
}

describe('si el JEV duda de que esté todo lo pedido, se revisa con la IA', () => {
  it('la IA dice qué falta, el JEV confirma que se pidió, y se completa', async () => {
    const { host, state } = stage(ANTES)
    const provider = ai([MEDIO, ENTERO], 'FALTA: Imprimir el total de los precios')
    const decider = jev(true)
    const outcome = await modify(
      host,
      { provider, decider },
      { command: 'calcula el total de unos precios y enséñalo', whole: true },
    )
    expect(provider.reviews).toBe(1)
    expect(decider.missingAsked).toBe(1)
    // La segunda reescritura es la que completa, con lo que faltaba dicho.
    expect(provider.rewrites[1]).toContain('Imprimir el total de los precios')
    expect(state.text).toBe(ENTERO)
    expect(outcome.doubt).toBe(false)
    expect(outcome.review).toEqual({ missing: ['Imprimir el total de los precios'], done: true })
    expect(summaryOf(outcome, ['cambio', 'cambios'])).toContain(
      'faltaba «imprimir el total de los precios»: ya está añadido',
    )
    // Se ve venir: se dice que se revisa y qué falta.
    expect(
      state.shown.some((one) => one.type === 'progress' && /reviso con la IA/.test(one.text)),
    ).toBe(true)
  })

  it('lo que la orden no pedía no se añade: la duda se resuelve sin tocar nada', async () => {
    const { host, state } = stage(ANTES)
    const provider = ai([MEDIO, ENTERO], 'FALTA: Añadir pruebas unitarias')
    const outcome = await modify(
      host,
      { provider, decider: jev(false) },
      { command: 'calcula el total de unos precios', whole: true },
    )
    expect(provider.rewrites).toHaveLength(1)
    expect(state.text).toBe(MEDIO)
    expect(outcome.doubt).toBe(false)
    expect(summaryOf(outcome, ['cambio', 'cambios'])).toContain('no falta nada de lo pedido')
  })

  it('si la IA ve que está completo, se dice; si no se entiende su respuesta, la duda se queda', async () => {
    const complete = await modify(
      stage(ANTES).host,
      { provider: ai([MEDIO], 'COMPLETO'), decider: jev(true) },
      { command: 'calcula el total', whole: true },
    )
    expect(complete.doubt).toBe(false)
    expect(complete.review).toEqual({ missing: [], done: true })
    const unclear = await modify(
      stage(ANTES).host,
      { provider: ai([MEDIO], 'Bueno, depende.'), decider: jev(true) },
      { command: 'calcula el total', whole: true },
    )
    expect(unclear.doubt).toBe(true)
    expect(unclear.review).toBeUndefined()
  })

  it('también se revisa si el JEV no duda pero tampoco está claramente seguro', async () => {
    const { host, state } = stage(ANTES)
    const provider = ai([MEDIO, ENTERO], 'FALTA: Imprimir el total')
    const outcome = await modify(
      host,
      // (0,7: por encima de la duda, por debajo de «claramente».)
      { provider, decider: jev(true, 0.7) },
      { command: 'calcula el total de unos precios y enséñalo', whole: true },
    )
    expect(provider.reviews).toBe(1)
    expect(state.text).toBe(ENTERO)
    expect(outcome.review?.done).toBe(true)
  })

  it('sin duda no se revisa nada', async () => {
    const provider = ai([ENTERO], 'FALTA: algo')
    const outcome = await modify(
      stage(ANTES).host,
      { provider, decider: jev(true) },
      { command: 'calcula el total y enséñalo', whole: true },
    )
    expect(outcome.doubt).toBe(false)
    expect(provider.reviews).toBe(0)
    expect(outcome.review).toBeUndefined()
  })
})

const ROTO = lines(
  'def total(precios):',
  '    return sum(precios)',
  '',
  'precios = [3, 4, 5]',
  'print("Total:", totl(precios))',
)

describe('la revisión ve el programa funcionar', () => {
  it('quien revisa lee lo que sale al ejecutarlo', async () => {
    const provider = ai([MEDIO, ENTERO], 'FALTA: Imprimir el total')
    await modify(
      stage(ANTES, true).host,
      { provider, decider: jev(true) },
      { command: 'calcula el total de unos precios y enséñalo', whole: true },
    )
    expect(provider.reviewed[0]).toContain('Al ejecutarlo (sin nadie delante) no imprime nada.')
  })

  it('si lo que se completa rompe lo que funcionaba, se arregla una vez, sin esperar a nadie', async () => {
    const { host, state } = stage(ANTES, true)
    const provider = ai([MEDIO, ROTO, ENTERO], 'FALTA: Imprimir el total')
    const outcome = await modify(
      host,
      { provider, decider: jev(true) },
      { command: 'calcula el total de unos precios y enséñalo', whole: true },
    )
    expect(provider.rewrites).toHaveLength(3)
    // El arreglo se pide con el fallo de verdad.
    expect(provider.rewrites[2]).toContain("NameError: name 'totl' is not defined")
    expect(state.text).toBe(ENTERO)
    expect(outcome.review).toMatchObject({ done: true, repaired: true })
    expect(summaryOf(outcome, ['cambio', 'cambios'])).toContain('arreglado un fallo')
  })

  it('si no se puede arreglar, se dice con qué falla', async () => {
    const provider = ai([MEDIO, ROTO, ROTO], 'FALTA: Imprimir el total')
    const outcome = await modify(
      stage(ANTES, true).host,
      { provider, decider: jev(true) },
      { command: 'calcula el total de unos precios y enséñalo', whole: true },
    )
    expect(outcome.review?.broken).toContain('NameError')
    expect(summaryOf(outcome, ['cambio', 'cambios'])).toContain('dejó de funcionar')
  })
})

describe('lo que dice quien revisa', () => {
  it('se lee como una lista de lo que falta, o como «completo»', () => {
    expect(
      missingOf('FALTA: Mostrar la gráfica.\n- FALTA: «Guardar el récord»\nOtra cosa'),
    ).toEqual(['Mostrar la gráfica', 'Guardar el récord'])
    expect(missingOf('COMPLETO')).toEqual([])
    expect(missingOf('No sé')).toBeNull()
    expect(missingOf('FALTA: a\nFALTA: b\nFALTA: c\nFALTA: d')).toHaveLength(3)
  })
})
