import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits } from '@prysel/python/edits'
import type { AiProvider } from '../src/ai/provider.ts'
import type { Decider } from '../src/jev/client.ts'
import { auditDiagram, type Outcome, type Stagehand } from '../src/jev/director.ts'
import {
  diagramAuditPrompt,
  diagramCorrectionsOf,
  movedSource,
  textKey,
  unusedFunctions,
  type Diagram,
} from '../src/jev/diagram.ts'
import { localDecider } from '../src/jev/local.ts'

/**
 * El auditor del diagrama: al acabar, mira lo que el lienzo dibuja —la forma, los nombres de las fases, sus
 * números y sus flechas— y propone cómo hacer que ayude a entender el programa. El JEV decide; lo aceptado se
 * aplica (mover una fase, renombrar, la forma) y se vuelve a mirar, sin deshacer lo de antes.
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

const ANTES = lines(
  'import random',
  '',
  '# Mostrar el resultado: imprime la mejor',
  'def mostrar(mejor):',
  '    print("Mejor:", mejor)',
  '',
  '# Preparar los datos: crea la lista',
  'def preparar():',
  '    return [random.random() for _ in range(3)]',
  '',
  '# Arrancar: lo pone en marcha',
  'mostrar(max(preparar()))',
)

const diagramOf = (diagramText: string, shape: string, shapes: string[]): Diagram => ({
  key: textKey(diagramText),
  shape,
  shapes,
  modules: (parse(diagramText).sections ?? [])
    .filter((section) => section.owner === undefined)
    .map((section, index) => ({
      id: section.id,
      n: String(index + 1),
      title: section.title,
      ...(section.subtitle ? { subtitle: section.subtitle } : {}),
    })),
  links: [],
})

describe('lo que dice el auditor del diagrama', () => {
  it('se lee como correcciones que tienen sentido en ese diagrama', () => {
    const diagram = diagramOf(ANTES, 'capas', ['tuberia', 'capas'])
    const said = [
      'MOVER 2 tras 0 | se prepara antes de mostrar',
      'MOVER 3 tras 0 | otra más',
      'RENOMBRAR 1 | Mostrar el resultado: imprime la mejor | igual',
      'UNIR 1 y 3 | Todo: hace todo | lejos',
      'FORMA ciclo | no lo tiene',
      'FORMA tuberia | es una cadena',
      'CONECTAR | que preparar le pase la lista a mostrar | se ve el dato',
    ]
    expect(diagramCorrectionsOf(said.join('\n'), diagram)).toEqual([
      // Una sola fase se mueve por vuelta; renombrar a lo mismo, unir fases lejanas o una forma que el grafo
      // no tiene no son correcciones.
      { kind: 'mover', at: 2, after: 0, why: 'se prepara antes de mostrar' },
      { kind: 'forma', shape: 'tuberia', why: 'es una cadena' },
      { kind: 'conectar', fix: 'que preparar le pase la lista a mostrar', why: 'se ve el dato' },
    ])
    expect(
      diagramCorrectionsOf('ARREGLAR | lleva el arranque a «Arrancar» | engaña', diagram),
    ).toEqual([{ kind: 'conectar', fix: 'lleva el arranque a «Arrancar»', why: 'engaña' }])
    // Lo que tiene cada fase se le enseña, para que vea lo que está donde no toca.
    const contents = new Map(diagram.modules.map((module) => [module.id, ['def mostrar(mejor):']]))
    expect(diagramAuditPrompt('x', diagram, ANTES, [], contents)).toContain(
      '1. Mostrar el resultado: imprime la mejor\n   tiene: def mostrar(mejor):',
    )
    expect(diagramCorrectionsOf('BIEN', diagram)).toEqual([])
    expect(diagramCorrectionsOf('ni idea', diagram)).toBeNull()
  })

  it('mover una fase deja las importaciones donde estaban y una línea en blanco entre fases', () => {
    const tops = (parse(ANTES).sections ?? []).filter((section) => section.owner === undefined)
    const starts = tops.map((section) => ANTES.lastIndexOf('\n', section.heading.start - 1) + 1)
    const blocks = starts.map((start, index) => ({
      start,
      end: starts[index + 1] ?? ANTES.length,
    }))
    const moved = movedSource(ANTES, blocks, 2, 0)
    expect(moved?.split('\n').filter((line) => line.startsWith('# '))).toEqual([
      '# Preparar los datos: crea la lista',
      '# Mostrar el resultado: imprime la mejor',
      '# Arrancar: lo pone en marcha',
    ])
    expect(moved?.startsWith('import random\n\n# Preparar')).toBe(true)
    expect(moved?.includes('\n\n# Mostrar el resultado')).toBe(true)
  })

  it('la huella del texto no depende de los finales de línea', () => {
    expect(textKey('a\r\nb\r\n')).toBe(textKey('a\nb\n'))
    expect(textKey('a\nb\n')).not.toBe(textKey('a\nc\n'))
  })
})

describe('al acabar, el diagrama', () => {
  /** Una IA de mentira: dice siempre lo mismo del diagrama (la segunda vez, mover deshace lo de antes). */
  function ai(): AiProvider & { asked: number } {
    const said = [
      'MOVER 2 tras 0 | lo que prepara va antes',
      'RENOMBRAR 3 | Poner en marcha: prepara y enseña la mejor | dice lo que hace',
      'FORMA tuberia | es una cadena',
    ].join('\n')
    const provider = {
      id: 'mentira',
      asked: 0,
      generate() {
        provider.asked++
        return Promise.resolve(said)
      },
    }
    return provider as unknown as AiProvider & { asked: number }
  }

  /** Un JEV que acepta lo que mejora el diagrama y nota cuando algo deshace lo ya corregido. */
  const jev: Decider = {
    id: 'prueba',
    async decide(request) {
      const result = await localDecider().decide(request)
      for (const id of Object.keys(request.questions)) {
        if (/^diagrama\d+$/.test(id)) result.answers[id] = { type: 'noul', noul: 0.9 }
        if (/^vuelta\d+$/.test(id)) result.answers[id] = { type: 'noul', noul: 0.9 }
      }
      return result
    },
  }

  function stage(level: 0 | 1 | 2 | 3) {
    const state = { text: ANTES, shape: 'capas', reshaped: [] as string[] }
    const host: Stagehand = {
      signal: new AbortController().signal,
      program: () => Promise.resolve(parse(state.text)),
      parses: (code) => !hasError(code),
      write(change) {
        if (change.edits.length === 0) return Promise.resolve(null)
        const next = applyEdits(state.text, change.edits)
        if (hasError(next)) return Promise.resolve('no vale')
        state.text = next
        return Promise.resolve(null)
      },
      show: () => Promise.resolve(),
      wait: () => Promise.resolve(),
      settle: () => Promise.resolve(),
      experts: { ui: 0, ux: 0, codigo: 0, ingenieria: 0, plan: level },
      diagram: () => Promise.resolve(diagramOf(state.text, state.shape, ['tuberia', 'capas'])),
      reshape(shape) {
        state.shape = shape
        state.reshaped.push(shape)
        return Promise.resolve()
      },
    }
    return { host, state }
  }

  const done = {
    written: 3,
    stopped: false,
    trouble: null,
    jevMs: 0,
    asked: 'un programa que enseñe el mejor de unos números al azar',
  } as unknown as Outcome

  it('el auditor corrige: mueve la fase que va antes, la renombra, cambia la forma y no deshace al volver a mirar', async () => {
    const provider = ai()
    const { host, state } = stage(3)
    const outcome = await auditDiagram(host, { provider, decider: jev }, 'x', done)
    expect(state.text.split('\n').filter((line) => line.startsWith('# '))).toEqual([
      '# Preparar los datos: crea la lista',
      '# Mostrar el resultado: imprime la mejor',
      '# Poner en marcha: prepara y enseña la mejor',
    ])
    expect(state.reshaped).toEqual(['tuberia'])
    // Miró dos veces: la segunda, mover otra vez la 2 (ahora «Mostrar») deshacía lo de antes.
    expect(provider.asked).toBe(2)
    const findings = outcome.diagramAudit?.findings ?? []
    expect(findings.filter((finding) => finding.applied)).toHaveLength(3)
    expect(findings.at(-1)).toMatchObject({ verdict: 'vuelta' })
    expect(findings.at(-1)?.applied).toBeUndefined()
  })

  it('si solo propone, lo cuenta y no toca nada', async () => {
    const { host, state } = stage(2)
    const outcome = await auditDiagram(host, { provider: ai(), decider: jev }, 'x', done)
    expect(state.text).toBe(ANTES)
    expect(state.reshaped).toEqual([])
    expect(outcome.diagramAudit?.findings).toHaveLength(3)
  })

  it('una fase que hace algo no salta por encima de otra que también: el programa haría otra cosa', async () => {
    const { host, state } = stage(3)
    state.text = lines(
      '# Saludar: dice hola',
      'print("hola")',
      '',
      '# Despedir: dice adiós',
      'print("adiós")',
      '',
      '# Contar: cuenta hasta tres',
      'for n in range(3):',
      '    print(n)',
    )
    const before = state.text
    const provider = {
      id: 'mentira',
      generate: () => Promise.resolve('MOVER 3 tras 0 | contar va antes'),
    } as unknown as AiProvider
    await auditDiagram(host, { provider, decider: jev }, 'x', done)
    expect(state.text).toBe(before)
  })
  it('una conexión que deja una función que nadie usa no ayuda: se deshace', async () => {
    const { host, state } = stage(3)
    const CON_SOBRANTE = `${ANTES}${['', 'def correr():', '    mostrar(max(preparar()))', ''].join('\n')}`
    const provider = {
      id: 'mentira',
      generate(request: { system: string }) {
        if (request.system.includes('AUDITOR INTERNO del diagrama'))
          return Promise.resolve(
            'CONECTAR | mete el arranque en una función correr | se ve el ciclo',
          )
        if (request.system.includes('programa ENTERO')) return Promise.resolve(CON_SOBRANTE)
        return Promise.resolve('Meto el arranque en una función.')
      },
    } as unknown as AiProvider
    const outcome = await auditDiagram(host, { provider, decider: jev }, 'x', done)
    expect(state.text).toBe(ANTES)
    expect(outcome.diagramAudit?.findings[0]?.applied).toBeUndefined()
  })

  it('separar una fase que hace dos cosas: solo se añade un rótulo, delante de la línea dicha', async () => {
    const { host, state } = stage(3)
    state.text = lines(
      'import random',
      '',
      '# Mostrar el resultado: imprime la mejor',
      'def mostrar(mejor):',
      '    print("Mejor:", mejor)',
      'def preparar():',
      '    return [random.random() for _ in range(3)]',
      '',
      '# Arrancar: lo pone en marcha',
      'mostrar(max(preparar()))',
    )
    const provider = {
      id: 'mentira',
      generate: () =>
        Promise.resolve(
          'SEPARAR 1 | def preparar(): | Preparar los datos: crea la lista | hace dos cosas',
        ),
    } as unknown as AiProvider
    const outcome = await auditDiagram(host, { provider, decider: jev }, 'x', done)
    expect(state.text).toContain(
      '    print("Mejor:", mejor)\n\n# Preparar los datos: crea la lista\ndef preparar():',
    )
    expect(outcome.diagramAudit?.findings[0]).toMatchObject({ applied: true })
  })

  it('las funciones sin usar: las que su nombre no sale en ningún otro sitio', () => {
    const source = [
      'def a():',
      '    b()',
      '',
      'def b():',
      '    pass',
      '',
      'def c():',
      '    pass',
      '',
      'boton("x", a)',
      '',
    ].join('\n')
    expect(unusedFunctions(source)).toEqual(['c'])
  })
})
