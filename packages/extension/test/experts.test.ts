import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits } from '@prysel/python/edits'
import type { AiProvider } from '../src/ai/provider.ts'
import type { Decider } from '../src/jev/client.ts'
import { modify, summaryOf, type Shown, type Stagehand } from '../src/jev/director.ts'
import { findingsOf, judgeFindings, levelsFrom, type ExpertLevels } from '../src/jev/experts.ts'
import { localDecider } from '../src/jev/local.ts'

/**
 * Los expertos: al acabar una orden, quien sabe de interfaz, de uso, de código limpio y de ingeniería mira lo
 * que quedó. La IA propone lo que ve cada uno; el JEV decide si se arregla, se sugiere o se descarta; y quien
 * lo usa elige cuánto está cada experto (apagado, observa, propone o corrige).
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
const ANTES = lines('def total(p):', '    return sum(p)', '', 'print(total([3, 4]))')
const CAMBIADO = lines(
  'def total(p):',
  '    return sum(p)',
  '',
  'print(total([3, 4]))',
  'print("Hecho")',
)
const MEJOR = lines(
  'def total(precios):',
  '    return sum(precios)',
  '',
  'print(total([3, 4]))',
  'print("Hecho")',
)

describe('lo que dice un experto', () => {
  it('se lee como hallazgos (grave o mejora, qué pasa, qué hacer), o como «bien»', () => {
    expect(
      findingsOf(
        'GRAVE | Todo sale negro | Usa colores que existan.\n- MEJORA | El nombre p no dice nada | Llama precios a p',
      ),
    ).toEqual([
      { severity: 'grave', what: 'Todo sale negro', fix: 'Usa colores que existan' },
      { severity: 'mejora', what: 'El nombre p no dice nada', fix: 'Llama precios a p' },
    ])
    expect(findingsOf('BIEN')).toEqual([])
    expect(findingsOf('no sé')).toBeNull()
  })

  it('el JEV decide de cada uno; si no está seguro, queda como sugerencia', async () => {
    const decider: Decider = {
      id: 'prueba',
      decide: () =>
        Promise.resolve({
          answers: {
            hallazgo0: { type: 'choice', choice: 'aplicar', confidence: 0.9 },
            hallazgo1: { type: 'choice', choice: 'descartar', confidence: 0.9 },
            hallazgo2: { type: 'choice', choice: 'aplicar', confidence: 0.3 },
          },
          ms: 0,
        }),
    }
    const finding = { severity: 'mejora' as const, what: 'algo', fix: 'haz algo' }
    const { verdicts } = await judgeFindings(decider, 'orden', 'codigo', [
      finding,
      finding,
      finding,
    ])
    expect(verdicts).toEqual(['aplicar', 'descartar', 'sugerir'])
  })

  it('los niveles guardados se leen con cuidado: lo que no vale, el de partida', () => {
    expect(levelsFrom({ ui: 3, ux: 9, codigo: 0 })).toEqual({
      ui: 3,
      ux: 2,
      codigo: 0,
      ingenieria: 1,
    })
  })
})

describe('la auditoría al acabar una orden', () => {
  function stage(levels: ExpertLevels) {
    const state = { text: ANTES, shown: [] as Shown[] }
    const host: Stagehand = {
      signal: new AbortController().signal,
      program: () => Promise.resolve(parse(state.text)),
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
      experts: levels,
    }
    return { host, state }
  }

  /** Una IA de mentira: reescribe (primero lo pedido, luego lo de los expertos) y habla como cada experto. */
  function ai(): AiProvider & { asked: string[] } {
    const queue = [CAMBIADO, MEJOR]
    const asked: string[] = []
    return {
      id: 'mentira',
      asked,
      generate(request: { system: string; prompt: string }) {
        if (request.system.includes('CÓDIGO LIMPIO')) {
          asked.push('codigo')
          return Promise.resolve(
            'MEJORA | El parámetro p no dice qué es | Llama precios al parámetro p',
          )
        }
        if (request.system.includes('EXPERIENCIA DE USO')) {
          asked.push('ux')
          return Promise.resolve(
            'MEJORA | No dice en qué moneda | Escribe la moneda junto al total',
          )
        }
        if (request.system.includes('INTERFAZ')) {
          asked.push('ui')
          return Promise.resolve('BIEN')
        }
        if (request.system.includes('programa ENTERO')) return Promise.resolve(queue.shift() ?? '')
        return Promise.resolve('Cambio lo que se imprime.')
      },
    } as unknown as AiProvider & { asked: string[] }
  }

  /** Un JEV que da por cumplido lo pedido y manda arreglar todo lo que proponen los expertos. */
  const jev: Decider = {
    id: 'prueba',
    async decide(request) {
      const result = await localDecider().decide(request)
      for (const id of Object.keys(request.questions)) {
        if (/^hallazgo\d+$/.test(id))
          result.answers[id] = { type: 'choice', choice: 'aplicar', confidence: 0.9 }
      }
      return result
    },
  }

  it('el que corrige aplica lo que el JEV confirma; el que propone, lo deja; el apagado no habla', async () => {
    const { host, state } = stage({ ui: 1, ux: 2, codigo: 3, ingenieria: 0 })
    const provider = ai()
    const outcome = await modify(
      host,
      { provider, decider: jev },
      { command: 'que diga «Hecho» al acabar', whole: true },
    )
    expect(provider.asked.sort()).toEqual(['codigo', 'ui', 'ux'])
    // Lo del experto en código limpio (corrige) se aplicó; lo de UX (propone) se queda propuesto.
    expect(state.text).toBe(MEJOR)
    const byId = Object.fromEntries(
      (outcome.audit?.experts ?? []).map((report) => [report.id, report]),
    )
    expect(byId['codigo']?.findings[0]).toMatchObject({ verdict: 'aplicar', applied: true })
    expect(byId['ux']?.findings[0]).toMatchObject({ verdict: 'aplicar' })
    expect(byId['ux']?.findings[0]?.applied).toBeUndefined()
    expect(byId['ui']?.findings).toEqual([])
    expect(summaryOf(outcome, ['cambio', 'cambios'])).toContain(
      'Los expertos arreglaron 1 cosa y tienen 1 recomendación',
    )
  })

  it('sin expertos presentes no se audita nada', async () => {
    const { host } = stage({ ui: 0, ux: 0, codigo: 0, ingenieria: 0 })
    const provider = ai()
    const outcome = await modify(
      host,
      { provider, decider: jev },
      { command: 'cambia', whole: true },
    )
    expect(provider.asked).toEqual([])
    expect(outcome.audit).toBeUndefined()
  })
})
