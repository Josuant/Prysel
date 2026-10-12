import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  autoWatches,
  measuredOf,
  parseWatches,
  pickWatches,
  plausibleWatch,
  progressOf,
  type Watch,
} from '../src/gist/progress.ts'
import type { Decider } from '../src/jev/client.ts'
import { Kernel } from '../src/kernel.ts'
import type { Probe } from '../src/trace.ts'
import { PROGRESS_ROWS, progressViewer } from '../webview/src/outcome.ts'

/**
 * Cómo avanza un programa vuelta a vuelta: qué se mira en su bucle principal (lo propone la IA, o son las
 * variables que el bucle cambia), lo que el motor mide de verdad al ejecutarlo, y lo que se elige enseñar.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0
const NL = String.fromCharCode(10)
const lines = (...rows: string[]) => rows.join(NL) + NL

/** Un algoritmo genético pequeño: una frase al azar que se va pareciendo a la que busca. */
const GENETIC = lines(
  'import random',
  'OBJETIVO = "hola"',
  'LETRAS = "abcdefghijklmnopqrstuvwxyz"',
  '',
  'def puntuar(cadena):',
  '    return sum(1 for a, b in zip(cadena, OBJETIVO) if a == b)',
  '',
  'def mutar(cadena):',
  '    lugar = random.randrange(len(cadena))',
  '    return cadena[:lugar] + random.choice(LETRAS) + cadena[lugar + 1:]',
  '',
  'def evolucionar():',
  '    poblacion = ["".join(random.choice(LETRAS) for _ in OBJETIVO) for _ in range(20)]',
  '    generaciones = 0',
  '    while puntuar(max(poblacion, key=puntuar)) < len(OBJETIVO):',
  '        padres = sorted(poblacion, key=puntuar, reverse=True)[:5]',
  '        poblacion = padres + [mutar(random.choice(padres)) for _ in range(15)]',
  '        generaciones += 1',
  '    return max(poblacion, key=puntuar), generaciones',
  '',
  'mejor, vueltas = evolucionar()',
  'print(mejor, vueltas)',
)
const LOOP_LINE = 15
const WATCH = [
  'max(poblacion, key=puntuar)',
  'puntuar(max(poblacion, key=puntuar))',
  'generaciones',
]

describe.skipIf(!available)('las sondas: lo que vale algo en cada vuelta', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  it('miden cada vuelta de verdad, hasta el final, sin cambiar lo que el programa da', async () => {
    const plain = await kernel.trace(GENETIC, 20_000, false, false, { seed: 7, finish: true })
    const watched = await kernel.trace(GENETIC, 20_000, false, false, {
      seed: 7,
      finish: true,
      watch: { line: LOOP_LINE, exprs: WATCH },
    })
    // Mirar no gasta el azar del programa ni imprime nada: da exactamente lo mismo.
    expect(watched.output).toBe(plain.output)
    const probe = watched.probe
    if (!probe) throw new Error('sin sondas')
    expect(probe.names).toEqual(WATCH)
    expect(probe.errors).toEqual([null, null, null])
    const [best = [], score = [], count = []] = probe.values
    // La última muestra es la del final: la frase que buscaba, con todas sus letras.
    expect(best[best.length - 1]).toEqual({ s: 'hola' })
    expect(score[score.length - 1]).toBe(4)
    // La puntuación de la mejor nunca baja (los padres pasan a la siguiente generación).
    const scores = score.filter((value): value is number => typeof value === 'number')
    expect(scores.every((value, at) => at === 0 || value >= (scores[at - 1] ?? 0))).toBe(true)
    // Y las vueltas que dice son las que el programa cuenta.
    const said = Number(plain.output.trim().split(' ')[1])
    expect(count[count.length - 1]).toBe(said)
    expect(probe.total).toBe(said + 1)
  })

  it('siguen midiendo cuando ya no se graba el paso a paso', async () => {
    const watched = await kernel.trace(GENETIC, 300, false, false, {
      seed: 7,
      finish: true,
      watch: { line: LOOP_LINE, exprs: ['generaciones'] },
    })
    expect(watched.truncated).toBe(true)
    expect(watched.finished).toBe(true)
    const count = watched.probe?.values[0] ?? []
    expect(count[count.length - 1]).toBe(Number(watched.output.trim().split(' ')[1]))
  })

  it('con muchas vueltas guardan una de cada tantas, y siempre la última', async () => {
    const source = lines('n = 0', 'while n < 1000:', '    n += 1', 'print(n)')
    const watched = await kernel.trace(source, 20_000, false, false, {
      finish: true,
      watch: { line: 2, exprs: ['n * 2'] },
    })
    const probe = watched.probe
    if (!probe) throw new Error('sin sondas')
    expect(probe.total).toBe(1001)
    expect(probe.laps.length).toBeLessThan(170)
    expect(probe.laps[0]).toBe(0)
    expect(probe.values[0]?.[probe.laps.length - 1]).toBe(2000)
  })

  it('lo que aún no existe en la primera vuelta se mira cuando existe', async () => {
    const source = lines(
      'total = 0',
      'for i in range(4):',
      '    ultimo = i * i',
      '    total += ultimo',
      'print(total)',
    )
    const watched = await kernel.trace(source, 20_000, false, false, {
      watch: { line: 2, exprs: ['ultimo'] },
    })
    expect(watched.probe?.values[0]).toEqual([null, 0, 1, 4, 9])
  })

  it('una sonda solo mira: lo que podría cambiar algo ni se evalúa', async () => {
    const source = lines('datos = [3, 1, 2]', 'for x in datos:', '    pass', 'print(datos)')
    const watched = await kernel.trace(source, 20_000, false, false, {
      watch: {
        line: 2,
        exprs: [
          'datos.sort()',
          'datos.append(9)',
          '__import__("os")',
          'open("x")',
          'sorted(datos)',
        ],
      },
    })
    expect(watched.output).toBe('[3, 1, 2]' + NL)
    const errors = watched.probe?.errors ?? []
    expect(errors.slice(0, 4).every((problem) => problem !== null)).toBe(true)
    expect(errors[4]).toBeNull()
    expect(watched.probe?.values[4]?.[0]).toEqual({ o: '[1, 2, 3]' })
  })
})

describe('qué se mira', () => {
  it('sin que nadie proponga nada, las variables que el bucle va cambiando', () => {
    expect(
      autoWatches(GENETIC, { line: LOOP_LINE, lineEnd: 18 }).map((watch) => watch.expr),
    ).toEqual(['padres', 'poblacion', 'generaciones'])
  })

  it('de lo que propone la IA, una expresión y su nombre por línea', () => {
    const answer = lines(
      '- `max(poblacion, key=puntuar)` ## La mejor frase',
      '2. puntuar(max(poblacion, key=puntuar)) ## «su puntuación»',
      'Esto no es una propuesta',
      'print(poblacion) ## imprime todo',
      'import os ## otra cosa',
    )
    expect(parseWatches(answer)).toEqual([
      { expr: 'max(poblacion, key=puntuar)', says: 'la mejor frase', proposed: true },
      { expr: 'puntuar(max(poblacion, key=puntuar))', says: 'su puntuación', proposed: true },
    ])
    expect(plausibleWatch('x; y')).toBe(false)
    expect(plausibleWatch('poblacion[0]')).toBe(true)
  })
})

describe('lo que se elige enseñar', () => {
  const watches: Watch[] = [
    { expr: 'mejor', says: 'la mejor frase', proposed: true },
    { expr: 'puntos', says: 'su puntuación', proposed: true },
    { expr: 'generaciones', says: 'generaciones' },
    { expr: 'tope', says: 'tope' },
  ]
  const probe: Probe = {
    line: 15,
    names: watches.map((watch) => watch.expr),
    laps: [0, 1, 2, 3],
    values: [
      [null, { s: 'xola' }, { s: 'hola' }, { s: 'hola' }],
      [1, 3, 4, 4],
      [0, 1, 2, 3],
      [9, 9, 9, 9],
    ],
    errors: [null, null, null, null],
    total: 4,
    cut: false,
  }

  it('de lo medido solo vale lo que cambia; y un contador de vueltas no cuenta nada', () => {
    const measured = measuredOf(probe, watches)
    expect(measured.map((one) => [one.watch.expr, one.kind])).toEqual([
      ['mejor', 'text'],
      ['puntos', 'number'],
    ])
    // Lo que aún no se podía mirar en la primera vuelta no está: sus vueltas son las que sí.
    expect(measured[0]?.laps).toEqual([1, 2, 3])
    expect(measured[0]?.texts).toEqual(['xola', 'hola', 'hola'])
  })

  const scripted = (answers: Record<string, { choice: string; confidence: number }>): Decider => ({
    id: 'guion',
    decide: (request) =>
      Promise.resolve({
        answers: Object.fromEntries(
          Object.keys(request.questions).flatMap((name) => {
            const answer = answers[name]
            return answer ? [[name, { type: 'choice' as const, ...answer }]] : []
          }),
        ),
        ms: 1,
      }),
  })

  it('el JEV elige entre lo medido; si dice que nada vale, no se enseña', async () => {
    const measured = measuredOf(probe, watches)
    const picked = await pickWatches(
      scripted({
        texto: { choice: 'c0', confidence: 0.9 },
        numero: { choice: 'ninguno', confidence: 0.9 },
      }),
      'while puntuar(mejor) < 4',
      measured,
    )
    expect(picked.text?.watch.expr).toBe('mejor')
    expect(picked.number).toBeNull()
    expect(progressOf(probe, picked)).toEqual({
      line: 15,
      total: 4,
      text: {
        says: 'la mejor frase',
        expr: 'mejor',
        laps: [1, 2, 3],
        values: ['xola', 'hola', 'hola'],
      },
    })
  })

  it('si el JEV no contesta o duda, queda lo primero que propuso la IA', async () => {
    const measured = measuredOf(probe, watches)
    const unsure = await pickWatches(
      scripted({ texto: { choice: 'ninguno', confidence: 0.2 } }),
      'while True',
      measured,
    )
    expect(unsure.text?.watch.expr).toBe('mejor')
    expect(unsure.number?.watch.expr).toBe('puntos')
    const failing: Decider = { id: 'roto', decide: () => Promise.reject(new Error('sin red')) }
    expect((await pickWatches(failing, 'while True', measured)).number?.watch.expr).toBe('puntos')
    expect(progressOf(probe, { text: null, number: null })).toBeNull()
  })
})

describe('el visor de cómo avanza', () => {
  it('lo que se lee, en unos momentos del primero al último, con las letras del final encendidas', () => {
    const viewer = progressViewer({
      line: 15,
      total: 40,
      text: {
        says: 'la mejor frase',
        expr: 'mejor',
        laps: [0, 1, 2, 3],
        values: ['xkzq', 'hkzq', 'hkzq', 'hola'],
      },
      number: { says: 'su puntuación', expr: 'puntos', laps: [0, 1, 2, 3], values: [0, 1, 1, 4] },
    })
    expect(viewer?.subtitle).toBe('la mejor frase · su puntuación')
    // Una vuelta en la que no cambió no es un momento.
    expect(viewer?.steps?.map((step) => `${step.label}:${step.text}`)).toEqual([
      '0:xkzq',
      '1:hkzq',
      '3:hola',
    ])
    expect(viewer?.steps?.[1]?.lit).toEqual([true, false, false, false])
    expect(viewer?.steps?.[2]?.lit).toEqual([true, true, true, true])
    expect(viewer?.series).toEqual({ at: [0, 1, 2, 3], values: [0, 1, 1, 4], n: 40 })
    expect(viewer?.text).toEqual(['su puntuación: de 0 a 4'])
  })

  it('con muchos momentos enseña unos pocos repartidos; y lo que cambia de tamaño no se compara letra a letra', () => {
    const laps = Array.from({ length: 30 }, (_, at) => at)
    const viewer = progressViewer({
      line: 2,
      total: 30,
      text: { says: 'la lista', expr: 'lista', laps, values: laps.map((n) => 'x'.repeat(n + 1)) },
    })
    expect(viewer?.steps).toHaveLength(PROGRESS_ROWS)
    expect(viewer?.steps?.[0]?.label).toBe('0')
    expect(viewer?.steps?.[PROGRESS_ROWS - 1]?.label).toBe('29')
    expect(viewer?.steps?.[0]?.lit).toBeUndefined()
    expect(viewer?.series).toBeUndefined()
    expect(progressViewer({ line: 2, total: 3 })).toBeNull()
  })
})
