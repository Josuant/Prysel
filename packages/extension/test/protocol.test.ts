import { describe, expect, it } from 'vitest'
import { parseHostMessage, parseWebviewMessage } from '../src/protocol.ts'

/**
 * El protocolo es la frontera entre el webview y el editor: lo que cruza se valida en cada
 * extremo. Un mensaje que no pasa la comprobación se descarta, nunca se interpreta a ciegas —
 * y una edición que llega mal formada es una escritura en el archivo del usuario.
 */

const edit = (over: Record<string, unknown> = {}) => ({
  type: 'edit',
  version: 3,
  edits: [{ start: 4, end: 5, text: '9' }],
  ...over,
})

describe('webview → extensión', () => {
  it('acepta «ready»', () => {
    expect(parseHostMessage({ type: 'ready' })).toEqual({ type: 'ready' })
  })

  it('acepta una edición bien formada, con la versión del texto sobre la que se calculó', () => {
    expect(parseHostMessage(edit())).toEqual(edit())
  })

  it('acepta varias ediciones en un mismo cambio', () => {
    const many = edit({
      edits: [
        { start: 0, end: 1, text: 'a' },
        { start: 5, end: 9, text: '' },
      ],
    })
    expect(parseHostMessage(many)).not.toBeNull()
  })

  it('descarta lo que no es un mensaje', () => {
    for (const bad of [null, undefined, 42, 'edit', [], {}, { type: 'otra-cosa' }]) {
      expect(parseHostMessage(bad)).toBeNull()
    }
  })

  it('descarta una edición sin versión: sin ella no se sabe a qué texto se refiere', () => {
    expect(parseHostMessage(edit({ version: undefined }))).toBeNull()
    expect(parseHostMessage(edit({ version: '3' }))).toBeNull()
    expect(parseHostMessage(edit({ version: 1.5 }))).toBeNull()
  })

  it('descarta una edición sin ediciones, o con demasiadas', () => {
    expect(parseHostMessage(edit({ edits: [] }))).toBeNull()
    expect(parseHostMessage(edit({ edits: 'no' }))).toBeNull()
    const flood = Array.from({ length: 65 }, (_, i) => ({
      start: i * 2,
      end: i * 2 + 1,
      text: 'x',
    }))
    expect(parseHostMessage(edit({ edits: flood }))).toBeNull()
  })

  it('descarta rangos que no son enteros, son negativos o van al revés', () => {
    for (const range of [
      { start: 1.5, end: 3, text: '' },
      { start: -1, end: 3, text: '' },
      { start: 5, end: 3, text: '' },
      { start: '1', end: 3, text: '' },
      { start: 1, end: null, text: '' },
    ]) {
      expect(parseHostMessage(edit({ edits: [range] }))).toBeNull()
    }
  })

  it('descarta un texto que no es texto, o desmesurado', () => {
    expect(parseHostMessage(edit({ edits: [{ start: 0, end: 1, text: 7 }] }))).toBeNull()
    expect(
      parseHostMessage(edit({ edits: [{ start: 0, end: 1, text: 'x'.repeat(200_001) }] })),
    ).toBeNull()
    expect(
      parseHostMessage(edit({ edits: [{ start: 0, end: 1, text: 'x'.repeat(200_000) }] })),
    ).not.toBeNull()
  })

  it('descarta una edición con una edición mal formada colada entre las buenas', () => {
    expect(
      parseHostMessage(edit({ edits: [{ start: 0, end: 1, text: 'a' }, { start: 'x' }] })),
    ).toBeNull()
  })
})

describe('extensión → webview', () => {
  const program = { nodes: [], edges: [], unsupported: [] }

  it('acepta una actualización, con o sin versión', () => {
    expect(parseWebviewMessage({ type: 'update', program })).not.toBeNull()
    expect(
      parseWebviewMessage({ type: 'update', program, version: 7, file: 'a.py' }),
    ).not.toBeNull()
  })

  it('acepta una actualización vacía (no hay archivo Python)', () => {
    expect(parseWebviewMessage({ type: 'update', program: null })).not.toBeNull()
  })

  it('descarta un programa mal formado', () => {
    expect(parseWebviewMessage({ type: 'update', program: { nodes: 1 } })).toBeNull()
  })

  it('acepta solo los temas conocidos', () => {
    expect(parseWebviewMessage({ type: 'theme', theme: 'dark' })).not.toBeNull()
    expect(parseWebviewMessage({ type: 'theme', theme: 'neon' })).toBeNull()
  })
})

describe('ejecución: webview → extensión', () => {
  it('acepta pedir ejecutar nodos o todo, con la versión del texto', () => {
    expect(parseHostMessage({ type: 'run', version: 4, ids: ['assign:3:0'] })).toEqual({
      type: 'run',
      version: 4,
      ids: ['assign:3:0'],
    })
    expect(parseHostMessage({ type: 'run', version: 4, ids: 'all' })).toEqual({
      type: 'run',
      version: 4,
      ids: 'all',
    })
  })

  it('acepta interrumpir y reiniciar', () => {
    expect(parseHostMessage({ type: 'interrupt' })).toEqual({ type: 'interrupt' })
    expect(parseHostMessage({ type: 'restart' })).toEqual({ type: 'restart' })
  })

  it('descarta una petición de ejecutar mal formada: es ejecutar código del usuario', () => {
    const bad = [
      { type: 'run', ids: ['a'] },
      { type: 'run', version: 1.5, ids: ['a'] },
      { type: 'run', version: 1, ids: [] },
      { type: 'run', version: 1, ids: [3] },
      { type: 'run', version: 1, ids: [''] },
      { type: 'run', version: 1, ids: 'algunos' },
      { type: 'run', version: 1, ids: Array.from({ length: 501 }, (_, i) => `n${i}`) },
      { type: 'run', version: 1, ids: ['x'.repeat(201)] },
    ]
    for (const message of bad) expect(parseHostMessage(message)).toBeNull()
  })
})

describe('ejecución: extensión → webview', () => {
  const runs = {
    type: 'runs',
    views: { 'assign:1:0': { state: 'fresh' } },
    kernel: 'idle',
    problem: null,
    version: 2,
  }

  it('acepta cómo está cada sentencia y el motor', () => {
    expect(parseWebviewMessage(runs)).toEqual(runs)
    expect(parseWebviewMessage({ ...runs, kernel: 'dead', problem: 'sin Python' })).not.toBeNull()
  })

  it('descarta un estado de motor que no existe, o una versión que no es un entero', () => {
    expect(parseWebviewMessage({ ...runs, kernel: 'volando' })).toBeNull()
    expect(parseWebviewMessage({ ...runs, version: 'dos' })).toBeNull()
    expect(parseWebviewMessage({ ...runs, views: [] })).toBeNull()
    expect(parseWebviewMessage({ ...runs, problem: 3 })).toBeNull()
  })

  it('acepta las imágenes de una ejecución, y descarta las mal formadas', () => {
    const assets = { type: 'assets', seq: 7, assets: { figures: [], images: {} } }
    expect(parseWebviewMessage(assets)).toEqual(assets)
    expect(parseWebviewMessage({ type: 'assets', seq: 7 })).toBeNull()
    expect(parseWebviewMessage({ type: 'assets', seq: 'x', assets: assets.assets })).toBeNull()
    expect(parseWebviewMessage({ type: 'assets', seq: 7, assets: { images: {} } })).toBeNull()
  })
})

describe('traza', () => {
  const trace = {
    events: [{ k: 'line', l: 1, d: 0, f: 0 }],
    truncated: false,
    error: null,
    output: '',
  }

  it('la petición del webview lleva la versión del texto', () => {
    expect(parseHostMessage({ type: 'trace', version: 3 })).toEqual({ type: 'trace', version: 3 })
    expect(parseHostMessage({ type: 'trace' })).toBeNull()
    expect(parseHostMessage({ type: 'trace', version: 'tres' })).toBeNull()
  })

  it('la respuesta acepta una grabación en curso, una terminada y un fallo', () => {
    const running = { type: 'trace', version: 3, status: 'running', trace: null }
    const done = { type: 'trace', version: 3, status: 'done', trace }
    const failed = {
      type: 'trace',
      version: 3,
      status: 'failed',
      trace: null,
      message: 'sin Python',
    }
    expect(parseWebviewMessage(running)).toEqual(running)
    expect(parseWebviewMessage(done)).toEqual(done)
    expect(parseWebviewMessage(failed)).toEqual(failed)
  })

  it('descarta una respuesta mal formada', () => {
    const done = { type: 'trace', version: 3, status: 'done', trace }
    expect(parseWebviewMessage({ ...done, status: 'volando' })).toBeNull()
    expect(parseWebviewMessage({ ...done, version: 'x' })).toBeNull()
    expect(parseWebviewMessage({ ...done, message: 4 })).toBeNull()
    expect(parseWebviewMessage({ ...done, trace: { ...trace, events: 'no' } })).toBeNull()
    expect(parseWebviewMessage({ ...done, trace: { ...trace, output: 3 } })).toBeNull()
    expect(parseWebviewMessage({ ...done, trace: { ...trace, truncated: 'sí' } })).toBeNull()
  })
})
