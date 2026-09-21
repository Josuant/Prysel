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
