import { describe, expect, it } from 'vitest'
import { speakableNote } from '../webview/src/useNarration.ts'

/**
 * Lo que se lee en voz alta de una nota (Fase E, voz sincronizada): el título, si tiene, y el texto sin
 * las marcas de Markdown (que si no, se leerían como asteriscos y comillas invertidas literales).
 */

describe('speakableNote', () => {
  it('sin título, solo el texto, sin marcas', () => {
    expect(speakableNote({ text: 'Empieza en **0**.' })).toBe('Empieza en 0.')
  })

  it('con título, va delante y remata con un punto', () => {
    expect(speakableNote({ title: 'Ojo', text: 'Con `total`.' })).toBe('Ojo. Con total.')
  })

  it('el texto sin marcas de ningún tipo se deja tal cual', () => {
    expect(speakableNote({ text: 'Nada especial aquí.' })).toBe('Nada especial aquí.')
  })
})
