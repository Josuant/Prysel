import { describe, expect, it } from 'vitest'
import {
  VIEWER,
  gridLayout,
  viewerHeight,
  viewerImageSize,
  viewerSize,
  viewerWidth,
} from '../src/viewer.ts'

/**
 * Cuánto mide un visor: crece con lo que enseña hasta un tope, y una imagen se ajusta sin ampliarse.
 */

const table = (columns: number, rows: number) => ({
  title: 't',
  table: {
    columns: Array.from({ length: columns }, (_, i) => ({ name: `c${i}`, dtype: 'int64' })),
    rows: Array.from({ length: rows }, () => Array.from({ length: columns }, () => 1)),
  },
})

describe('el ancho de un visor', () => {
  it('una tabla crece con sus columnas, dentro de unos límites', () => {
    expect(viewerWidth(table(1, 3))).toBe(VIEWER.minW)
    expect(viewerWidth(table(4, 3))).toBeGreaterThan(viewerWidth(table(2, 3)))
    expect(viewerWidth(table(30, 3))).toBe(VIEWER.tableMaxW)
  })

  it('una imagen se ajusta a su tamaño, sin pasar del máximo', () => {
    expect(viewerWidth({ title: 'f', image: { src: 'x', w: 100, h: 100 } })).toBe(VIEWER.minW)
    expect(viewerWidth({ title: 'f', image: { src: 'x', w: 5000, h: 100 } })).toBe(VIEWER.maxW)
  })

  it('el texto tiene un ancho de serie', () => {
    expect(viewerWidth({ title: 'x', text: ['a'] })).toBe(300)
  })
})

describe('la imagen dentro del visor', () => {
  it('no se amplía', () => {
    expect(viewerImageSize({ title: 'f', image: { src: 'x', w: 100, h: 50 } })).toEqual({
      w: 100,
      h: 50,
    })
  })

  it('se reduce a lo que cabe, conservando la proporción', () => {
    const size = viewerImageSize({ title: 'f', image: { src: 'x', w: 1600, h: 800 } })
    expect(size.w).toBe(VIEWER.maxW - 2 * VIEWER.pad - 2)
    expect(size.h).toBe(Math.round(size.w / 2))
  })

  it('no pasa del alto máximo', () => {
    const size = viewerImageSize({ title: 'f', image: { src: 'x', w: 300, h: 3000 } })
    expect(size.h).toBeLessThanOrEqual(VIEWER.imageMaxH)
    expect(size.w / size.h).toBeCloseTo(0.1, 1)
  })

  it('sin imagen, nada', () => {
    expect(viewerImageSize({ title: 'x' })).toEqual({ w: 0, h: 0 })
  })
})

describe('el alto de un visor', () => {
  it('crece con las filas de su tabla y con las líneas de su texto', () => {
    expect(viewerHeight(table(2, 8))).toBeGreaterThan(viewerHeight(table(2, 2)))
    expect(viewerHeight({ title: 'x', text: ['a', 'b', 'c'] })).toBeGreaterThan(
      viewerHeight({ title: 'x', text: ['a'] }),
    )
  })

  it('una línea más larga que el visor cuenta por las filas que ocupa', () => {
    const short = viewerHeight({ title: 'x', text: ['Mejor: 42'] })
    const long = viewerHeight({ title: 'x', text: ['Mejor encontrado: hola mundo, tras 120 gen.'] })
    expect(long).toBe(short + VIEWER.line)
    // Y una que cabe justa no pide una fila de más.
    const perRow = Math.floor(
      (viewerWidth({ title: 'x', text: ['a'] }) - 2 * VIEWER.pad) / VIEWER.char,
    )
    expect(viewerHeight({ title: 'x', text: ['a'.repeat(perRow)] })).toBe(short)
  })

  it('crece con sus tiras de barras y con las filas de rejillas que hagan falta', () => {
    const strip = { label: '0', values: [3, 1, 2] }
    expect(viewerHeight({ title: 'x', strips: [strip, strip, strip] })).toBe(
      viewerHeight({ title: 'x', strips: [strip] }) + 2 * VIEWER.strip,
    )
    const grid = (size: number) => ({
      label: '0',
      cells: Array.from({ length: size }, () => Array.from({ length: size }, () => 0)),
    })
    // Tres tableros pequeños caben en una fila; seis grandes, no: el visor crece hacia abajo.
    const small = { title: 'x', grids: [grid(4), grid(4), grid(4)] }
    const big = { title: 'x', grids: Array.from({ length: 6 }, () => grid(20)) }
    expect(gridLayout(small.grids, viewerWidth(small)).rows).toBe(1)
    expect(gridLayout(big.grids, viewerWidth(big)).rows).toBeGreaterThan(1)
    expect(viewerHeight(big)).toBeGreaterThan(viewerHeight(small))
    expect(viewerWidth(big)).toBeLessThanOrEqual(VIEWER.maxW)
    // Una casilla nunca es tan pequeña que no se vea, ni tan grande que el tablero no quepa.
    expect(gridLayout(big.grids, 400).cell).toBeGreaterThanOrEqual(3)
    expect(gridLayout(small.grids, 320).w).toBeLessThan(320)
  })

  it('siempre cabe su cabecera y una línea', () => {
    expect(viewerHeight({ title: 'x' })).toBeGreaterThanOrEqual(VIEWER.head + VIEWER.line)
  })

  it('tabla e imagen a la vez suman', () => {
    const both = { ...table(2, 2), image: { src: 'x', w: 200, h: 100 } }
    expect(viewerHeight(both)).toBeGreaterThan(viewerHeight(table(2, 2)))
  })

  it('el tamaño junta ancho y alto', () => {
    const content = table(3, 4)
    expect(viewerSize(content)).toEqual({ w: viewerWidth(content), h: viewerHeight(content) })
  })
})
