import { describe, expect, it } from 'vitest'
import { moveNoteIn, parseLesson } from '../src/lesson.ts'
import { parseHostMessage } from '../src/protocol.ts'

/**
 * Una nota arrastrada a mano se queda donde se dejó: el guion guarda cuánto se aparta del sitio que le
 * da el margen. Se guarda sobre el JSON tal cual (sin perder nada que esta versión no conozca).
 */

const lesson = (note: Record<string, unknown>) => ({
  version: 1,
  title: 'x',
  beats: [{ id: 'b1', at: { text: 'total = 0' }, note: { text: 'Empieza en cero.', ...note } }],
})

describe('la posición a mano de una nota, en el guion', () => {
  it('se lee y se redondea', () => {
    const parsed = parseLesson(lesson({ offset: { x: 12.4, y: -30.6 } }))
    expect(parsed.ok && parsed.lesson.beats[0]?.note.offset).toEqual({ x: 12, y: -31 })
  })

  it('una posición que no son dos números (o desorbitada) no vale', () => {
    expect(parseLesson(lesson({ offset: { x: 'a', y: 1 } })).ok).toBe(false)
    expect(parseLesson(lesson({ offset: { x: 1 } })).ok).toBe(false)
    expect(parseLesson(lesson({ offset: { x: 1e9, y: 0 } })).ok).toBe(false)
  })

  it('arrastrarla la escribe en su momento, sin tocar lo demás (tampoco lo que no se conoce)', () => {
    const raw = JSON.stringify({ ...lesson({}), extra: { futuro: true } })
    const moved = moveNoteIn(raw, 'b1', { x: 40, y: -8 })
    const value = JSON.parse(moved ?? '{}')
    expect(value.beats[0].note.offset).toEqual({ x: 40, y: -8 })
    expect(value.beats[0].note.text).toBe('Empieza en cero.')
    expect(value.extra).toEqual({ futuro: true })
  })

  it('devolverla a su sitio quita la posición', () => {
    const raw = JSON.stringify(lesson({ offset: { x: 5, y: 5 } }))
    const value = JSON.parse(moveNoteIn(raw, 'b1', null) ?? '{}')
    expect(value.beats[0].note.offset).toBeUndefined()
  })

  it('solo cambia la posición de esa nota: el resto del archivo se queda como lo escribió su autor', () => {
    const raw = [
      '{',
      '  "version": 1,',
      '  "title": "x",',
      '  "show": ["stack", "tree"],',
      '  "beats": [',
      '    {',
      '      "id": "b1",',
      '      "at": { "text": "total = 0" },',
      '      "note": {',
      '        "text": "Empieza en cero.",',
      '        "style": "sticky"',
      '      }',
      '    },',
      '    { "id": "b2", "at": { "text": "x" }, "note": { "text": "Otra.", "style": "margin" } }',
      '  ]',
      '}',
      '',
    ].join('\n')
    const moved = moveNoteIn(raw, 'b1', { x: 40.4, y: -8 }) ?? ''
    expect(moved).toBe(
      raw.replace(
        '"style": "sticky"\n',
        '"style": "sticky",\n        "offset": { "x": 40, "y": -8 }\n',
      ),
    )
    // Otra vez: se reescribe en su sitio.
    const again = moveNoteIn(moved, 'b1', { x: 1, y: 2 }) ?? ''
    expect(again).toBe(moved.replace('{ "x": 40, "y": -8 }', '{ "x": 1, "y": 2 }'))
    // Devolverla a su sitio deja el archivo como estaba, byte a byte.
    expect(moveNoteIn(again, 'b1', null)).toBe(raw)
    // En un objeto de una línea va detrás, en la misma línea.
    const inline = moveNoteIn(raw, 'b2', { x: 3, y: 4 }) ?? ''
    expect(inline).toContain(
      '"note": { "text": "Otra.", "style": "margin", "offset": { "x": 3, "y": 4 } } }',
    )
    expect(moveNoteIn(inline, 'b2', null)).toBe(raw)
  })

  it('respeta los saltos de línea de Windows, y una posición que va primera también se quita', () => {
    const raw =
      '{\r\n  "version": 1,\r\n  "title": "x",\r\n  "beats": [\r\n    {\r\n      "id": "b1",\r\n' +
      '      "at": { "text": "t" },\r\n      "note": {\r\n        "text": "Hola.",\r\n' +
      '        "style": "sticky"\r\n      }\r\n    }\r\n  ]\r\n}\r\n'
    const moved = moveNoteIn(raw, 'b1', { x: 5, y: 6 }) ?? ''
    expect(moved).toContain('"style": "sticky",\r\n        "offset": { "x": 5, "y": 6 }\r\n')
    expect(moveNoteIn(moved, 'b1', null)).toBe(raw)

    const first = '{"beats":[{"id":"b1","note":{"offset":{"x":1,"y":1},"text":"Hola."}}]}'
    expect(moveNoteIn(first, 'b1', null)).toBe('{"beats":[{"id":"b1","note":{"text":"Hola."}}]}')
  })

  it('un momento que no existe, o un texto que no es un guion: nada', () => {
    expect(moveNoteIn(JSON.stringify(lesson({})), 'otro', { x: 1, y: 1 })).toBeNull()
    expect(moveNoteIn('esto no es json', 'b1', { x: 1, y: 1 })).toBeNull()
  })

  it('el mensaje del lienzo se valida', () => {
    expect(parseHostMessage({ type: 'noteMove', beat: 'b1', offset: { x: 3, y: 4 } })).toEqual({
      type: 'noteMove',
      beat: 'b1',
      offset: { x: 3, y: 4 },
    })
    expect(parseHostMessage({ type: 'noteMove', beat: 'b1', offset: null })).toEqual({
      type: 'noteMove',
      beat: 'b1',
      offset: null,
    })
    expect(parseHostMessage({ type: 'noteMove', beat: '', offset: null })).toBeNull()
    expect(parseHostMessage({ type: 'noteMove', beat: 'b1', offset: { x: 'a', y: 1 } })).toBeNull()
  })
})
