import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  NOTE,
  NOTE_STYLES,
  isNoteStyle,
  noteLines,
  noteSize,
  noteSpans,
  placeNotes,
  plainNote,
} from '../src/note.ts'
import { NOTE_STYLE_IDS } from '../../extension/src/lesson.ts'

/**
 * Las notas a mano: cómo se lee su formato, cuánto miden y que el guion y el lienzo hablan de las mismas
 * clases de nota.
 */

describe('el formato de una nota', () => {
  it('separa la negrita y el código, y deja el resto como texto', () => {
    expect(noteSpans('Una **idea** con `x = 1` dentro')).toEqual([
      { text: 'Una ', kind: 'plain' },
      { text: 'idea', kind: 'bold' },
      { text: ' con ', kind: 'plain' },
      { text: 'x = 1', kind: 'code' },
      { text: ' dentro', kind: 'plain' },
    ])
  })

  it('una marca que no cierra se queda como texto, no se pierde', () => {
    expect(noteSpans('un ** suelto y un ` solo')).toEqual([
      { text: 'un ** suelto y un ` solo', kind: 'plain' },
    ])
    expect(plainNote('**a** y `b`')).toBe('a y b')
  })

  it('no interpreta nada más: es texto, no HTML', () => {
    expect(noteSpans('<img src=x onerror=alert(1)>')).toEqual([
      { text: '<img src=x onerror=alert(1)>', kind: 'plain' },
    ])
  })
})

describe('lo que mide una nota', () => {
  it('crece con lo que dice', () => {
    const short = noteSize({ text: 'Hola', style: 'sticky' })
    const long = noteSize({ text: 'palabra '.repeat(40), style: 'sticky' })
    expect(long.h).toBeGreaterThan(short.h + 3 * NOTE.line)
    expect(long.w).toBe(short.w)
  })

  it('cuenta las líneas al partir por palabras y respeta los saltos', () => {
    expect(noteLines('una dos tres')).toBe(1)
    expect(noteLines('a\nb\nc')).toBe(3)
    expect(noteLines('x'.repeat(NOTE.perLine * 2 + 1))).toBe(3)
    expect(noteLines('')).toBe(1)
  })

  it('el título suma una fila, y una nota al margen es más estrecha', () => {
    const plain = noteSize({ text: 'Hola', style: 'sticky' })
    expect(noteSize({ text: 'Hola', style: 'sticky', title: 'T' }).h).toBe(plain.h + NOTE.title)
    expect(noteSize({ text: 'Hola', style: 'margin' }).w).toBeLessThan(plain.w)
  })
})

describe('las clases de nota', () => {
  it('el guion y el lienzo conocen las mismas', () => {
    expect(Object.keys(NOTE_STYLES).sort()).toEqual([...NOTE_STYLE_IDS].sort())
  })

  it('reconoce solo las que existen (y no las heredadas de Object)', () => {
    expect(isNoteStyle('sticky')).toBe(true)
    expect(isNoteStyle('toString')).toBe(false)
    expect(isNoteStyle(3)).toBe(false)
  })

  it('cada clase tiene su forma en la hoja de estilos, no solo su color', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    for (const style of Object.keys(NOTE_STYLES)) {
      expect(css, style).toContain(`.note[data-style='${style}']`)
    }
  })
})

describe('el margen de las notas', () => {
  const slot = (id: string, y: number, h = 60) => ({
    id,
    anchor: { x: 0, y, w: 100, h: 40 },
    size: { w: NOTE.width, h },
  })

  it('cada nota va a la altura de lo que explica, en la columna del margen', () => {
    const placed = placeNotes([slot('a', 100), slot('b', 400)], 900)
    expect(placed.get('a')).toEqual({ x: 900, y: 100 + 20 - 30 })
    expect(placed.get('b')).toEqual({ x: 900, y: 400 + 20 - 30 })
  })

  it('si dos se pisarían, se apartan lo justo en los dos sentidos, sin solaparse', () => {
    const placed = placeNotes([slot('b', 110), slot('a', 100)], 900, 14)
    const a = placed.get('a')
    const b = placed.get('b')
    // `a` va primero (su ancla está más arriba) y la separación es el alto de una nota más el hueco.
    expect((b?.y ?? 0) - (a?.y ?? 0)).toBe(60 + 14)
    // Reparten el desplazamiento: ni una se queda donde quería y la otra se va lejos.
    expect((a?.y ?? 0) + (b?.y ?? 0)).toBeCloseTo(90 + 100)
  })

  it('las que cuelgan del mismo nodo se reparten alrededor de él', () => {
    const placed = placeNotes([slot('a', 300), slot('b', 300), slot('c', 300)], 900, 10)
    const ys = ['a', 'b', 'c'].map((id) => placed.get(id)?.y ?? 0)
    // La del medio queda donde quería estar (centrada en el ancla).
    expect(ys[1]).toBeCloseTo(300 + 20 - 30)
    expect((ys[1] ?? 0) - (ys[0] ?? 0)).toBe(70)
    expect((ys[2] ?? 0) - (ys[1] ?? 0)).toBe(70)
  })

  it('nunca se solapan, sean cuales sean las alturas de sus anclas', () => {
    const anchors = [10, 12, 15, 200, 205, 210, 214, 500]
    const placed = placeNotes(
      anchors.map((y, i) => slot(String(i), y, 40 + (i % 3) * 25)),
      0,
      8,
    )
    const rects = anchors.map((_, i) => ({
      y: placed.get(String(i))?.y ?? 0,
      h: 40 + (i % 3) * 25,
    }))
    for (let i = 1; i < rects.length; i++) {
      const before = rects[i - 1]
      const now = rects[i]
      expect((now?.y ?? 0) + 0.001).toBeGreaterThanOrEqual((before?.y ?? 0) + (before?.h ?? 0) + 8)
    }
  })

  it('el sitio de una nota no depende de las demás que ya estaban más arriba', () => {
    const one = placeNotes([slot('a', 100)], 900)
    const two = placeNotes([slot('a', 100), slot('b', 500)], 900)
    expect(two.get('a')).toEqual(one.get('a'))
  })
})
