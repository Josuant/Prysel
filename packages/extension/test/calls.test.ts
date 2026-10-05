import { describe, expect, it } from 'vitest'
import type { AiProvider } from '../src/ai/provider.ts'
import { CallLog, MAX_CALLS, MAX_CALL_TEXT, type CallEntry } from '../src/calls.ts'
import { localDecider } from '../src/jev/local.ts'
import { parseHostMessage, parseWebviewMessage } from '../src/protocol.ts'

/**
 * El registro de consultas: lo que se le manda a cada modelo y lo que contesta, para verlo en la pestaña
 * «Consultas». Envuelve al proveedor y al decisor sin cambiar lo que hacen.
 */

/** Un registro que apunta cada aviso (una copia: la entrada sigue cambiando). */
function logging() {
  const seen: CallEntry[] = []
  let clock = 1000
  const log = new CallLog(
    (entry) => {
      seen.push({ ...entry })
    },
    () => clock,
  )
  return {
    log,
    seen,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

describe('lo que se le pide a la IA generativa', () => {
  it('queda apuntado con su respuesta y lo que tardó, sin cambiar lo que devuelve', async () => {
    const { log, seen, tick } = logging()
    const inner: AiProvider = {
      id: 'deepseek:deepseek-flash',
      generate: () => {
        tick(420)
        return Promise.resolve('{"code": "x = 1"}')
      },
    }
    const provider = log.provider(inner)
    expect(provider.id).toBe('deepseek:deepseek-flash')
    expect(await provider.generate({ system: 'Eres…', prompt: 'Orden: una variable' })).toBe(
      '{"code": "x = 1"}',
    )
    expect(seen.map((entry) => entry.status)).toEqual(['running', 'done'])
    expect(seen[1]).toEqual({
      id: 1,
      at: 1000,
      kind: 'ia',
      model: 'deepseek:deepseek-flash',
      status: 'done',
      ms: 420,
      system: 'Eres…',
      prompt: 'Orden: una variable',
      text: '{"code": "x = 1"}',
    })
    // Sin `stream` en el proveedor, tampoco lo tiene el envuelto.
    expect(provider.stream).toBeUndefined()
  })

  it('una respuesta en streaming se ve llegar, y se apunta entera al acabar', async () => {
    const { log, seen, tick } = logging()
    const provider = log.provider({
      id: 'm',
      generate: () => Promise.resolve(''),
      stream(_request, onText) {
        for (const piece of ['{"code"', ': "x = 1"', '}']) {
          tick(300)
          onText(piece)
        }
        return Promise.resolve('{"code": "x = 1"}')
      },
    })
    const pieces: string[] = []
    await provider.stream?.({ system: 's', prompt: 'p' }, (delta) => pieces.push(delta))
    expect(pieces).toEqual(['{"code"', ': "x = 1"', '}'])
    expect(seen.map((entry) => entry.text)).toEqual([
      undefined,
      '{"code"',
      '{"code": "x = 1"',
      '{"code": "x = 1"}',
      '{"code": "x = 1"}',
    ])
    expect(seen[seen.length - 1]).toMatchObject({ status: 'done', ms: 900 })
  })

  it('un fallo queda apuntado con su motivo, y se sigue lanzando', async () => {
    const { log, seen } = logging()
    const provider = log.provider({
      id: 'm',
      generate: () => Promise.reject(new Error('DeepSeek respondió 401')),
    })
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow('401')
    expect(seen[1]).toMatchObject({ status: 'failed', error: 'DeepSeek respondió 401' })
  })

  it('un texto enorme se recorta, y solo se recuerdan las últimas consultas', async () => {
    const { log } = logging()
    const provider = log.provider({ id: 'm', generate: () => Promise.resolve('ok') })
    await provider.generate({ system: 's', prompt: 'x'.repeat(MAX_CALL_TEXT + 500) })
    expect(log.all()[0]?.prompt).toHaveLength(MAX_CALL_TEXT + '\n… (500 caracteres más)'.length)
    for (let i = 0; i < MAX_CALLS + 5; i++) await provider.generate({ system: 's', prompt: 'p' })
    expect(log.all()).toHaveLength(MAX_CALLS)
    log.clear()
    expect(log.all()).toEqual([])
  })
})

describe('lo que se le pregunta al JEV', () => {
  it('queda apuntado: el estado, cada pregunta con sus opciones, y cada respuesta con su certeza', async () => {
    const { log, seen } = logging()
    const decider = log.decider(localDecider())
    expect(decider.id).toBe('local')
    const response = await decider.decide({
      state: { orden: 'añade un bucle' },
      questions: {
        es_orden: { type: 'noul', instructions: '¿Es una orden?' },
        accion: {
          type: 'choice',
          instructions: '¿Qué pide?',
          criteria: { agregar: 'Añadir', eliminar: 'Quitar', otra: null },
        },
      },
    })
    expect(response.answers.accion).toMatchObject({ choice: 'agregar' })
    expect(seen[1]).toMatchObject({
      kind: 'jev',
      model: 'local',
      status: 'done',
      state: { orden: 'añade un bucle' },
      questions: [
        { id: 'es_orden', type: 'noul', instructions: '¿Es una orden?' },
        {
          id: 'accion',
          type: 'choice',
          instructions: '¿Qué pide?',
          options: ['agregar', 'eliminar', 'otra'],
        },
      ],
      answers: [
        { id: 'es_orden', answer: 'sí', confidence: 0.9 },
        { id: 'accion', answer: 'agregar', confidence: 0.9 },
      ],
    })
  })
})

describe('los mensajes de las consultas se validan', () => {
  it('una consulta hacia el lienzo, y vaciarlas desde él', () => {
    const entry = { id: 1, at: 5, kind: 'ia', model: 'm', status: 'running', prompt: 'p' }
    expect(parseWebviewMessage({ type: 'call', entry })).toEqual({ type: 'call', entry })
    expect(parseWebviewMessage({ type: 'call', entry: { ...entry, kind: 'otro' } })).toBeNull()
    expect(parseWebviewMessage({ type: 'call', entry: { ...entry, status: 'x' } })).toBeNull()
    expect(parseWebviewMessage({ type: 'call' })).toBeNull()
    expect(parseHostMessage({ type: 'clearCalls' })).toEqual({ type: 'clearCalls' })
  })
})
