import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../src/gist/gist.ts'
import { RUNS_SHOWN, runEntry, runsViewer, type RunEntry } from '../webview/src/outcome.ts'

/**
 * Las ejecuciones: lo que fue dando el programa cada vez que se ejecutó (al mover una perilla, al tirar otra
 * vez, tras una orden) y qué provocó cada una. Es la historia del resultado, en un visor a su lado.
 */

const NL = String.fromCharCode(10)
const ok = (output: string): RunSummary => ({ output, ended: 'done' })

describe('lo que se apunta de una ejecución', () => {
  it('lo último que enseñó y, si lleva alguno, su último número', () => {
    const run = ok(
      ['Generación 1', 'Mejor encontrado: hola mundo tras 41 generaciones', ''].join(NL),
    )
    expect(runEntry(run, 'al abrirlo', 1)).toEqual({
      n: 1,
      cause: 'al abrirlo',
      said: 'Mejor encontrado: hola mundo tras 41 generaciones',
      value: 41,
    })
    expect(runEntry(ok('A cada uno le tocan 136.5' + NL), 'partes = 2', 2)?.value).toBe(136.5)
    expect(runEntry(ok('Listo' + NL), 'otra tirada', 3)).toMatchObject({
      said: 'Listo',
      value: null,
    })
  })

  it('un fallo se apunta como fallo; lo que no enseña nada, también se dice', () => {
    const broken: RunSummary = {
      output: '',
      ended: 'error',
      problem: 'ZeroDivisionError: division by zero',
    }
    expect(runEntry(broken, 'partes = 0', 4)).toMatchObject({
      said: 'falla: ZeroDivisionError: division by zero',
      value: null,
    })
    expect(runEntry({ output: '', ended: 'idle', idle: 'mute' }, 'un cambio', 5)?.said).toBe(
      'no enseña nada',
    )
  })

  it('si no llegó a ejecutarse, o se quedó pidiendo un dato, no se apunta', () => {
    expect(runEntry({ output: '', ended: 'blocked' }, 'un cambio', 1)).toBeNull()
    expect(runEntry({ output: '¿Tu nombre? ', ended: 'waiting' }, 'un cambio', 1)).toBeNull()
  })
})

describe('el visor de las ejecuciones', () => {
  const entry = (n: number, value: number | null): RunEntry => ({
    n,
    cause: n === 1 ? 'al abrirlo' : `tamano = ${n * 10}`,
    said: value === null ? 'Listo' : `tras ${value} generaciones`,
    value,
  })

  it('con una sola no hay historia: lo dice el resultado', () => {
    expect(runsViewer([])).toBeNull()
    expect(runsViewer([entry(1, 41)])).toBeNull()
  })

  it('dice de cada una qué cambió y qué dio, y dibuja cómo va cambiando el número', () => {
    const viewer = runsViewer([entry(1, 41), entry(2, 30), entry(3, 55)])
    expect(viewer?.title).toBe('Ejecuciones')
    expect(viewer?.text).toEqual([
      '1. al abrirlo → tras 41 generaciones',
      '2. tamano = 20 → tras 30 generaciones',
      '3. tamano = 30 → tras 55 generaciones',
    ])
    expect(viewer?.series).toEqual({ at: [0, 1, 2], values: [41, 30, 55], n: 3 })
  })

  it('si alguna no enseña un número, no hay curva que dibujar', () => {
    const viewer = runsViewer([entry(1, 41), entry(2, null)])
    expect(viewer?.series).toBeUndefined()
    expect(viewer?.text).toHaveLength(2)
  })

  it('enseña las últimas, con su número de orden de verdad', () => {
    const many = Array.from({ length: RUNS_SHOWN + 3 }, (_, at) => entry(at + 1, at))
    const viewer = runsViewer(many)
    expect(viewer?.text).toHaveLength(RUNS_SHOWN)
    expect(viewer?.text?.[0]?.startsWith('4. ')).toBe(true)
    expect(viewer?.text?.at(-1)?.startsWith(`${RUNS_SHOWN + 3}. `)).toBe(true)
  })
})
