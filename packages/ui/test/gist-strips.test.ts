import { describe, expect, it } from 'vitest'
import {
  gistPieceSize,
  gistShape,
  gistSize,
  gistStrips,
  STRIP,
  type GistPiece,
  type GistValue,
} from '../src/gist.ts'

/**
 * Lo que mide lo nuevo de las tarjetas «Qué hace»: las tiras de un mecanismo (filas de celdas alineadas) y una
 * lista de textos largos, que va en columna para no hacer una tarjeta de un metro.
 */

const text = (value: string): GistValue => ({ kind: 'atom', type: 'text', text: `'${value}'` })
const list = (items: GistValue[]): GistValue => ({
  kind: 'list',
  shape: 'list',
  items,
  more: false,
})

describe('una lista de textos largos', () => {
  const population = list(
    ['kemubc rdl', 'sbqgbcnnch', 'crnb sdhuu', 'kosoljhzfw', 'sbssmbhbre', 'jnerdsjr v'].map(text),
  )

  it('va en columna: una tarjeta estrecha y más alta, no una fila de un metro', () => {
    const shape = gistShape(population)
    expect(shape).toMatchObject({ as: 'cells', stacked: true })
    const size = gistPieceSize({ type: 'datum', label: 'poblacion', value: population })
    expect(size.w).toBeLessThan(140)
    expect(size.h).toBeGreaterThan(6 * 22)
    // Con sus seis elementos a la vista.
    expect(shape.as === 'cells' && shape.cells.length).toBe(6)
  })

  it('una lista corta de cosas cortas sigue en fila', () => {
    const numbers = list(
      [1, 0, 1, 1, 0, 0, 1, 0].map((n): GistValue => ({
        kind: 'atom',
        type: 'number',
        text: String(n),
      })),
    )
    expect(gistShape(numbers)).not.toMatchObject({ stacked: true })
    expect(gistPieceSize({ type: 'datum', value: numbers }).h).toBeLessThan(30)
  })

  it('con muchas, se enseñan las primeras y se dice que hay más', () => {
    const many = list(Array.from({ length: 20 }, (_, at) => text(`individuo ${at}`)))
    const shape = gistShape(many)
    expect(shape).toMatchObject({ as: 'cells', stacked: true, more: true })
    expect(shape.as === 'cells' && shape.cells.length).toBeLessThanOrEqual(8)
  })
})

describe('las tiras de un mecanismo', () => {
  const cells = (word: string) => [...word].map((letter) => ({ text: letter }))
  const mix: Extract<GistPiece, { type: 'strips' }> = {
    type: 'strips',
    label: 'mezcla',
    tour: 'columns',
    strips: [
      { name: 'padre1', cells: cells('kemubc rdl') },
      { name: 'padre2', cells: cells('sbqgbcnnch') },
      { name: 'devuelve', cells: cells('kemuqcnnch'), arrives: true },
    ],
  }

  it('todas las celdas miden lo mismo: van alineadas, columna a columna', () => {
    const { cellW, nameW, cells: count } = gistStrips(mix)
    expect(count).toBe(10)
    const size = gistPieceSize(mix)
    expect(size.w).toBeGreaterThanOrEqual(nameW + 10 * cellW)
    expect(size.h).toBe(15 + 3 * STRIP.row)
  })

  it('una fila muy larga se corta y dice cuántas celdas quedan fuera', () => {
    const long: typeof mix = {
      ...mix,
      strips: [{ name: 'x', cells: cells('abcdefghijklmnopqrstuvwxyz') }],
    }
    const [strip] = gistStrips(long).strips
    expect(strip?.cells.length).toBe(STRIP.maxCells)
    expect(strip?.more).toBe(26 - STRIP.maxCells)
  })

  it('el medidor y el pie cuentan para lo que mide la tarjeta', () => {
    const plain = gistPieceSize(mix)
    const measured = gistPieceSize({
      ...mix,
      gauge: { value: 3, of: 10, says: 'coinciden' },
      foot: '1 no viene de ninguno: es nuevo',
    })
    expect(measured.h).toBe(plain.h + STRIP.gauge + 22)
    expect(gistSize({ name: 'cruzar', lanes: [[mix]] }).w).toBeGreaterThanOrEqual(plain.w)
  })
})
