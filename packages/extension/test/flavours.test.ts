import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits } from '@prysel/python/edits'
import type { AiProvider, AiRequest } from '../src/ai/provider.ts'
import type { Decider, JevAnswer } from '../src/jev/client.ts'
import { build, type Shown, type Stagehand } from '../src/jev/director.ts'
import { localDecider } from '../src/jev/local.ts'
import { flavourFromLine, flavoursOf, withFlavour } from '../src/jev/plain.ts'

/**
 * Los **sabores**: una petición abierta («un algoritmo genético») no dice qué caso concreto construir. Se
 * proponen unas pocas versiones, el JEV elige la que mejor se ve funcionar, se construye esa y se dice cuál
 * fue, para poder cambiar a otra. Una petición que ya dice lo que quiere se hace tal cual.
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

const FLAVOURS = [
  'Frase que evoluciona: una frase al azar se va pareciendo a «hola mundo» generación a generación',
  '- Todo unos: una fila de ceros y unos que acaba siendo todo unos',
  '3. Mochila: qué objetos llevar para sumar el mayor valor sin pasarse de peso',
].join('\n')

/** Una IA de mentira que propone versiones, un plan de dos partes y un programa mínimo. */
function ai(): AiProvider & { requests: AiRequest[] } {
  const requests: AiRequest[] = []
  const answer = (request: AiRequest) => {
    requests.push(request)
    if (request.system.includes('petición abierta')) return FLAVOURS
    if (request.system.includes('Lista las partes'))
      return 'Preparar: los datos de partida\nEnseñar: el resultado <- Preparar'
    if (request.system.includes('solo el código'))
      return '# Preparar\nx = 1\n\n# Enseñar\nprint(x)\n'
    if (request.system.includes('Antes de empezar')) return 'Vamos a ello.'
    return '1. Esto.'
  }
  return {
    id: 'mentira',
    requests,
    generate: (request) => Promise.resolve(answer(request)),
    async stream(request, onText) {
      const text = answer(request)
      onText(text)
      await Promise.resolve()
      return text
    },
  }
}

/** El decisor local, salvo en lo que aquí se prueba: si la petición es abierta y qué versión se elige. */
function judging(open: number, flavour = 'v1'): Decider & { asked: string[] } {
  const local = localDecider()
  const asked: string[] = []
  return {
    id: 'sabores',
    asked,
    async decide(request) {
      const response = await local.decide(request)
      const answers: Record<string, JevAnswer> = { ...response.answers }
      for (const id of Object.keys(request.questions)) asked.push(id)
      if ('abierta' in request.questions) answers['abierta'] = { type: 'noul', noul: open }
      if ('sabor' in request.questions)
        answers['sabor'] = { type: 'choice', choice: flavour, confidence: 0.9 }
      return { ...response, answers }
    },
  }
}

function stage(source = '') {
  const control = new AbortController()
  const state = { text: source, shown: [] as Shown[] }
  const host: Stagehand = {
    signal: control.signal,
    program: () => Promise.resolve(parse(state.text)),
    parses: (code) => !hasError(code),
    write(change) {
      if (change.edits.length === 0) return Promise.resolve(null)
      const next = applyEdits(state.text, change.edits)
      if (hasError(next)) return Promise.resolve('no vale')
      state.text = next
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

const request = (command: string) => ({
  command,
  gen: 'g1',
  place: {},
  where: 'al final del programa',
  outline: true,
  flow: 'stream' as const,
})

describe('las versiones de una petición abierta', () => {
  it('se leen de la respuesta: una por línea, con su título y lo que se verá', () => {
    expect(flavoursOf(FLAVOURS).map((flavour) => flavour.title)).toEqual([
      'Frase que evoluciona',
      'Todo unos',
      'Mochila',
    ])
    expect(flavourFromLine('Claro, aquí tienes tres versiones:')).toBeNull()
    expect(flavourFromLine('**Todo unos**: una fila que acaba siendo todo unos.')).toEqual({
      title: 'Todo unos',
      shows: 'una fila que acaba siendo todo unos',
    })
    // Dos veces la misma no son dos versiones.
    expect(flavoursOf(`${FLAVOURS}\nTodo unos: lo mismo otra vez, repetido`).length).toBe(3)
  })

  it('una petición abierta se hace concreta: el JEV elige, se dice cuál, y se construye esa', async () => {
    const provider = ai()
    const decider = judging(0.9, 'v1')
    const { host, state } = stage()
    await build(host, { decider, provider }, request('Un algoritmo genético'))
    const told = state.shown.find((event) => event.type === 'flavours')
    expect(told).toMatchObject({ chosen: 1 })
    expect(told?.type === 'flavours' && told.options.map((option) => option.title)).toEqual([
      'Frase que evoluciona',
      'Todo unos',
      'Mochila',
    ])
    // El plan y el código se piden ya para esa versión, no para el tema en general.
    const plan = provider.requests.find((asked) => asked.system.includes('Lista las partes'))
    const code = provider.requests.find((asked) => asked.system.includes('solo el código'))
    expect(plan?.prompt).toContain('En concreto, esta versión: Todo unos')
    expect(code?.prompt).toContain('En concreto, esta versión: Todo unos')
    expect(state.text).toContain('print(x)')
    // Y se dice antes de dibujar el plan.
    const order = state.shown.map((event) => event.type)
    expect(order.indexOf('flavours')).toBeLessThan(order.indexOf('architecture'))
  })

  it('una petición que ya dice lo que quiere se hace tal cual, sin proponer nada', async () => {
    const provider = ai()
    const { host, state } = stage()
    await build(
      host,
      { decider: judging(0.1), provider },
      request('Suma los números del 1 al 10 y enseña el total'),
    )
    expect(state.shown.some((event) => event.type === 'flavours')).toBe(false)
    expect(provider.requests.some((asked) => asked.system.includes('petición abierta'))).toBe(false)
    const plan = provider.requests.find((asked) => asked.system.includes('Lista las partes'))
    expect(plan?.prompt).not.toContain('En concreto')
  })

  it('pedir otra de las versiones la construye sin volver a elegir', async () => {
    const provider = ai()
    const decider = judging(0.9)
    const { host, state } = stage()
    const flavour = { title: 'Mochila', shows: 'qué objetos llevar sin pasarse de peso' }
    await build(host, { decider, provider }, { ...request('Un algoritmo genético'), flavour })
    expect(state.shown.some((event) => event.type === 'flavours')).toBe(false)
    expect(decider.asked).not.toContain('abierta')
    const plan = provider.requests.find((asked) => asked.system.includes('Lista las partes'))
    expect(plan?.prompt).toContain(withFlavour('Un algoritmo genético', flavour).split('\n')[1])
  })

  it('sobre un programa que ya existe no se proponen versiones: se añade lo que se pidió', async () => {
    const provider = ai()
    const decider = judging(0.9)
    const { host, state } = stage('y = 2\n')
    await build(host, { decider, provider }, request('Un algoritmo genético'))
    expect(state.shown.some((event) => event.type === 'flavours')).toBe(false)
    expect(decider.asked).not.toContain('abierta')
  })
})
