import { describe, expect, it } from 'vitest'
import type { ModuleFacts } from '@prysel/ui'
import type { RunSummary } from '../src/gist/gist.ts'
import { moduleStates, outcomeOf } from '../webview/src/outcome.ts'

/**
 * Los dos extremos de la arquitectura: dónde empieza el trabajo y qué sale al final. Salen de cómo le fue al
 * programa al ejecutarlo, no de lo que alguien diga de él.
 */

const module = (id: string, line: number, lineEnd: number): ModuleFacts => ({
  id,
  title: id,
  asks: false,
  prints: false,
  defines: false,
  stores: false,
  loops: false,
  branches: false,
  calls: 0,
  line,
  lineEnd,
})
const MODULES = [module('datos', 1, 4), module('calcular', 6, 12), module('arrancar', 14, 16)]

describe('el resultado, como un nodo más', () => {
  it('lo último que salió por pantalla, y de qué módulos salió', () => {
    const run: RunSummary = {
      output: 'Generación 1\nGeneración 2\nResultado: hola mundo\n',
      ended: 'done',
      sources: [8, 8, 16],
      start: 15,
    }
    const { result, start } = outcomeOf(run, MODULES)
    expect(result).toEqual({
      from: ['calcular', 'arrancar'],
      content: {
        title: 'Resultado',
        subtitle: 'Lo último que salió por pantalla',
        text: ['Generación 1', 'Generación 2', 'Resultado: hola mundo'],
      },
    })
    // El trabajo empieza en el módulo de la primera línea que llamó a una función propia.
    expect(start).toEqual({ at: 'arrancar', label: 'Empieza aquí' })
  })

  it('con mucha salida, solo el final (que es cómo acabó); las líneas largas, recortadas', () => {
    const rows = Array.from({ length: 12 }, (_, at) => `vuelta ${at + 1}`)
    const run: RunSummary = {
      output: `${rows.join('\n')}\n${'x'.repeat(80)}\n`,
      ended: 'done',
      sources: [...rows.map(() => 8), 16],
    }
    const text = outcomeOf(run, MODULES).result?.content.text ?? []
    expect(text).toHaveLength(5)
    expect(text[0]).toBe('vuelta 9')
    expect(text[4]?.length).toBe(46)
  })

  it('si falló o se cortó, se dice: es hasta donde llegó', () => {
    const run: RunSummary = { output: 'Total: 3\n', ended: 'error', sources: [8], problem: 'x' }
    expect(outcomeOf(run, MODULES).result?.content.subtitle).toBe('Hasta donde llegó: falló')
  })

  it('sin nada en pantalla (y sin ser un programa parado), no hay nodo', () => {
    expect(outcomeOf({ output: '', ended: 'done' }, MODULES).result).toBeNull()
    expect(outcomeOf({ output: '', ended: 'blocked' }, MODULES).result).toBeNull()
  })
})

describe('un programa que todavía no hace nada', () => {
  it('nadie lo arranca: el resultado lo dice, y no sale de ningún módulo', () => {
    const { result, start } = outcomeOf({ output: '', ended: 'idle', idle: 'inert' }, MODULES)
    expect(result).toMatchObject({
      planned: true,
      from: [],
      content: { subtitle: 'Todavía no hay', text: ['Nadie arranca el programa todavía.'] },
    })
    expect(start).toBeNull()
  })

  it('con su función principal probada aparte, se enseña lo que daría, saliendo de su módulo', () => {
    const run: RunSummary = {
      output: '',
      ended: 'idle',
      idle: 'inert',
      entry: 'algoritmo_genetico',
      trial: { call: 'algoritmo_genetico(20, 50)', returned: "'hola mundo'" },
    }
    expect(outcomeOf(run, MODULES, 7).result).toEqual({
      planned: true,
      from: ['calcular'],
      content: {
        title: 'Resultado',
        subtitle: 'Lo que daría: probado aparte con un ejemplo',
        text: ['algoritmo_genetico(20, 50)', "→ 'hola mundo'"],
      },
    })
  })

  it('trabaja pero no enseña nada: también se dice', () => {
    const run: RunSummary = { output: '', ended: 'idle', idle: 'mute', start: 15 }
    const { result, start } = outcomeOf(run, MODULES)
    expect(result?.content.text).toEqual(['Trabaja, pero no enseña nada.'])
    expect(start?.at).toBe('arrancar')
  })
})

describe('el estado de cada módulo, tras ejecutar el programa', () => {
  // Tres módulos de funciones (uno sin usar), uno de código suelto que se ejecuta y otro que no llega.
  const defines = (id: string, line: number, lineEnd: number) => ({
    ...module(id, line, lineEnd),
    defines: true,
  })
  const modules = [
    defines('evaluar', 1, 3),
    defines('mutar', 5, 7),
    defines('olvidada', 9, 11),
    module('arrancar', 13, 15),
    module('despedida', 17, 18),
  ]
  const nodes = [1, 5, 9].map((line) => ({ kind: 'abstraction.collapsed', line }))
  const run = (more: Partial<RunSummary> = {}): RunSummary => ({
    output: 'hola',
    ended: 'done',
    usage: { calls: { 1: 40, 5: 12 }, lines: [1, 5, 9, 13, 14] },
    ...more,
  })

  it('cuántas veces se usó cada uno, quién no se usa, y por dónde no se pasó', () => {
    const states = moduleStates(run(), nodes, modules)
    expect(states['evaluar']).toMatchObject({ tone: 'ran', label: '×40' })
    expect(states['mutar']).toMatchObject({ tone: 'ran', label: '×12' })
    expect(states['olvidada']).toMatchObject({ tone: 'unused', label: 'sin usar' })
    // El código suelto que se ejecutó no lleva marca: es lo normal.
    expect(states['arrancar']).toBeUndefined()
    expect(states['despedida']).toMatchObject({ tone: 'idle', label: 'no se ejecutó' })
  })

  it('si se dejó de contar antes del final, son «al menos» y no se acusa a nadie de no usarse', () => {
    const states = moduleStates(
      run({ usage: { calls: { 1: 40 }, lines: [1, 5, 9, 13], partial: true } }),
      nodes,
      modules,
    )
    expect(states['evaluar']).toMatchObject({ tone: 'ran', label: '×40+' })
    expect(states['mutar']).toBeUndefined()
    expect(states['olvidada']).toBeUndefined()
    expect(states['despedida']).toBeUndefined()
  })

  it('donde falló, se dice; y con un fallo, lo que no llegó a usarse no es «sin usar»', () => {
    const states = moduleStates(
      run({ ended: 'error', line: 6, problem: 'ZeroDivisionError: division by zero' }),
      nodes,
      modules,
    )
    expect(states['mutar']).toMatchObject({ tone: 'failed', label: 'falló aquí' })
    expect(states['mutar']?.title).toContain('ZeroDivisionError')
    expect(states['olvidada']).toBeUndefined()
    expect(states['despedida']).toBeUndefined()
  })

  it('sin ejecución (o sin saber qué se usó) no se dice nada', () => {
    expect(moduleStates(null, nodes, modules)).toEqual({})
    expect(moduleStates({ output: '', ended: 'done' }, nodes, modules)).toEqual({})
  })
})
