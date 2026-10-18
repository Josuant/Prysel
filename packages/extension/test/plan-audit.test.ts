import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits } from '@prysel/python/edits'
import type { AiProvider, AiRequest } from '../src/ai/provider.ts'
import type { Decider } from '../src/jev/client.ts'
import { build, type Stagehand } from '../src/jev/director.ts'
import {
  correctedPlan,
  correctionsOf,
  DEFAULT_LEVELS,
  type ExpertLevels,
} from '../src/jev/experts.ts'
import { localDecider } from '../src/jev/local.ts'

/**
 * El auditor del plan: un experto interno que, antes de escribir nada, mira las partes del plan. Que sean
 * congruentes (cada una hace algo distinto, en orden, hacia lo pedido) y que cada una aporte algo. La IA
 * propone correcciones; el JEV decide cuáles mejoran el plan; con el auditor corrigiendo (lo de partida), el
 * plan se rehace antes de escribir el código.
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

const PLAN = lines(
  '1. Preparar las notas: guarda las notas de la clase',
  '2. Guardar las notas: guarda las notas en una lista',
  '3. Mostrar la media: imprime la media de las notas',
)
const AUDIT =
  'UNIR 1 y 2 | Preparar las notas: guarda las notas de la clase | las dos hacen lo mismo'
const CODE = lines('notas = [7, 4, 9]', 'print(sum(notas) / len(notas))')

describe('lo que dice el auditor', () => {
  it('se lee como correcciones válidas para ese plan (o «bien»)', () => {
    expect(correctionsOf(AUDIT, 3)).toEqual([
      {
        kind: 'unir',
        at: 1,
        with: 2,
        part: { title: 'Preparar las notas', goal: 'guarda las notas de la clase' },
        why: 'las dos hacen lo mismo',
      },
    ])
    expect(correctionsOf('QUITAR 9 | no existe', 3)).toBeNull()
    expect(correctionsOf('BIEN', 3)).toEqual([])
    expect(
      correctionsOf('AÑADIR tras 3 | Arrancar: lo pone en marcha | falta', 3)?.[0],
    ).toMatchObject({ kind: 'añadir', after: 3 })
  })

  it('el plan corregido: quitar, unir, cambiar y añadir, con los números del plan de antes', () => {
    const parts = [
      { title: 'A', goal: 'a' },
      { title: 'B', goal: 'b', needs: ['A'] },
      { title: 'C', goal: 'c', needs: ['B'] },
    ]
    const done = correctedPlan(parts, [
      { kind: 'unir', at: 1, with: 2, part: { title: 'AB', goal: 'ab' }, why: '' },
      { kind: 'añadir', after: 3, part: { title: 'D', goal: 'd' }, why: '' },
    ])
    expect(done.map((part) => part.title)).toEqual(['AB', 'C', 'D'])
    // Lo que necesitaba la parte que se unió a otra, ahora lo necesita de la nueva.
    expect(done[1]?.needs).toEqual(['AB'])
  })

  it('los números y las flechas: mover una parte, conectar y soltar', () => {
    const said = [
      'MOVER 3 tras 0 | se usa antes',
      'CONECTAR 1 a 2 | la usa',
      'SOLTAR 2 de 3 | no la usa',
    ]
    expect(correctionsOf(said.join('\n'), 3)).toEqual([
      { kind: 'mover', at: 3, after: 0, why: 'se usa antes' },
      { kind: 'conectar', at: 2, from: 1, why: 'la usa' },
      { kind: 'soltar', at: 3, from: 2, why: 'no la usa' },
    ])
    // Mover una parte a donde ya está no es una corrección.
    expect(correctionsOf('MOVER 2 tras 1 | da igual', 3)).toBeNull()
    const parts = [
      { title: 'Escuchar', goal: 'graba', needs: ['Preparar'] },
      { title: 'Traducir', goal: 'a notas' },
      { title: 'Preparar', goal: 'la melodía' },
    ]
    const done = correctedPlan(parts, [
      { kind: 'mover', at: 3, after: 0, why: '' },
      { kind: 'conectar', at: 2, from: 1, why: '' },
      { kind: 'soltar', at: 1, from: 3, why: '' },
    ])
    expect(done).toEqual([
      { title: 'Preparar', goal: 'la melodía' },
      { title: 'Escuchar', goal: 'graba' },
      { title: 'Traducir', goal: 'a notas', needs: ['Escuchar'] },
    ])
  })

  it('de partida, todos los expertos corrigen, también el auditor del plan', () => {
    expect(DEFAULT_LEVELS).toEqual({ ui: 3, ux: 3, codigo: 3, ingenieria: 3, plan: 3 })
  })
})

describe('antes de escribir el código', () => {
  function ai(): AiProvider & { kinds: string[] } {
    const kinds: string[] = []
    const answer = (request: AiRequest) => {
      const kind = request.system.includes('AUDITOR INTERNO')
        ? 'audit'
        : request.system.includes('Lista las partes')
          ? 'plan'
          : request.system.includes('solo el código')
            ? 'code'
            : 'otro'
      kinds.push(kind)
      if (kind === 'audit') return AUDIT
      if (kind === 'plan') return PLAN
      if (kind === 'code') return CODE
      return 'Aquí va.'
    }
    return {
      id: 'mentira',
      kinds,
      generate: (request) => Promise.resolve(answer(request)),
      async stream(request, onText) {
        const text = answer(request)
        onText(text)
        await Promise.resolve()
        return text
      },
    }
  }

  function stage(levels: ExpertLevels) {
    const state = { text: '', frames: [] as string[] }
    const host: Stagehand = {
      signal: new AbortController().signal,
      program: () => Promise.resolve(parse(state.text)),
      parses: (code) => !hasError(code),
      write(change) {
        if (change.edits.length === 0) return Promise.resolve(null)
        const next = applyEdits(state.text, change.edits)
        if (hasError(next)) return Promise.resolve('no vale')
        state.text = next
        state.frames.push(next)
        return Promise.resolve(null)
      },
      show: () => Promise.resolve(),
      wait: () => Promise.resolve(),
      settle: () => Promise.resolve(),
      experts: levels,
    }
    return { host, state }
  }

  /** Un JEV que acepta lo que propone el auditor. */
  const accepting: Decider = {
    id: 'prueba',
    async decide(request) {
      const result = await localDecider().decide(request)
      for (const id of Object.keys(request.questions)) {
        if (/^corregir\d+$/.test(id)) result.answers[id] = { type: 'noul', noul: 0.9 }
      }
      return result
    },
  }
  const request = {
    command: 'un programa que calcule la media de unas notas',
    gen: 'g1',
    place: {},
    where: 'al final del programa',
    outline: true,
  }
  const off = { ui: 0, ux: 0, codigo: 0, ingenieria: 0 } as const

  it('con el auditor corrigiendo, el plan se rehace (dos partes que repetían, una) antes del código', async () => {
    const provider = ai()
    const { host, state } = stage({ ...off, plan: 3 })
    const outcome = await build(host, { decider: accepting, provider }, request)
    // Se auditó después del plan y antes del código.
    expect(provider.kinds.indexOf('audit')).toBeGreaterThan(provider.kinds.indexOf('plan'))
    expect(provider.kinds.indexOf('audit')).toBeLessThan(provider.kinds.indexOf('code'))
    // El último plan dibujado antes del código ya es el corregido.
    const skeletons = state.frames.filter(
      (frame) => frame.includes('prysel:gen:') && !frame.includes('notas = '),
    )
    expect(skeletons.at(-1)).not.toContain('Guardar las notas')
    expect(state.text).not.toContain('# Guardar las notas')
    expect(state.text).toContain('# Mostrar la media')
    const report = outcome.audit?.experts[0]
    expect(report?.id).toBe('plan')
    expect(report?.findings[0]).toMatchObject({ verdict: 'aplicar', applied: true })
    expect(report?.findings[0]?.fix).toContain('Unir «Preparar las notas» y «Guardar las notas»')
  })

  it('si solo observa, el plan se queda como estaba y lo cuenta', async () => {
    const { host, state } = stage({ ...off, plan: 1 })
    const outcome = await build(host, { decider: accepting, provider: ai() }, request)
    // (Al final se quita la parte a la que no fue código: lo que se mira es el plan antes del código.)
    const skeletons = state.frames.filter(
      (frame) => frame.includes('prysel:gen:') && !frame.includes('notas = '),
    )
    expect(skeletons.at(-1)).toContain('# Guardar las notas')
    expect(outcome.audit?.experts[0]?.findings[0]?.applied).toBeUndefined()
  })
})
