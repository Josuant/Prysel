import { describe, expect, it } from 'vitest'
import {
  VIEWER,
  gridLayout,
  momentLaps,
  playCursor,
  playFrames,
  playStage,
  withLive,
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

describe('un visor que se reproduce', () => {
  const steps = [
    { label: '0', text: 'xkzq' },
    { label: '12', text: 'hkzq' },
    { label: '40', text: 'hola' },
  ]

  it('sus momentos son sus filas, sus tiras o sus rejillas: la vuelta de cada uno', () => {
    expect(momentLaps({ title: 'x', steps })).toEqual([0, 12, 40])
    expect(momentLaps({ title: 'x', strips: [{ label: '3', values: [1, 2] }] })).toEqual([3])
    expect(momentLaps({ title: 'x' })).toEqual([])
  })

  it('con solo una curva, unos puntos repartidos de su primera vuelta a la última', () => {
    const laps = momentLaps({
      title: 'x',
      series: { at: [0, 10, 20, 70], values: [1, 2, 3, 4], n: 71 },
    })
    expect(laps[0]).toBe(0)
    expect(laps[laps.length - 1]).toBe(70)
    expect(laps.every((lap, at) => at === 0 || lap >= (laps[at - 1] ?? 0))).toBe(true)
  })

  it('empieza en el punto de partida, corre paso a paso hasta el último y acaba entero', () => {
    const play = (phase: 'start' | 'run' | 'end') => ({ phase, ms: 1000, serial: 1 })
    // Sin reproducir, no va por ninguno: se ve entero.
    expect(playCursor(undefined, 3, 0)).toBeNull()
    expect(playCursor(play('start'), 3, 2)).toBe(0)
    expect([0, 1, 2, 9].map((step) => playCursor(play('run'), 3, step))).toEqual([0, 1, 2, 2])
    expect(playCursor(play('end'), 3, 0)).toBe(2)
    expect(playCursor(play('run'), 0, 0)).toBeNull()
  })
})

describe('la película de un visor: reproducirlo de corrido', () => {
  const content = {
    title: 'x',
    steps: [
      { label: '0', text: 'xkzq', lit: [false, false, false, false] },
      { label: '4', text: 'hkzq', lit: [true, false, false, false] },
      { label: '9', text: 'hola', lit: [true, true, true, true] },
    ],
    film: {
      laps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      texts: ['xkzq', 'xkzq', 'xkza', 'hkza', 'hkzq', 'hkzq', 'hkla', 'hkla', 'hola', 'hola'],
    },
  }

  it('recorre todos sus fotogramas; sin película, sus momentos', () => {
    expect(playFrames(content)).toEqual(content.film.laps)
    expect(playFrames({ title: 'x', steps: content.steps })).toEqual([0, 4, 9])
  })

  it('va por el último momento alcanzado o, camino del siguiente, por ese (en vivo)', () => {
    const moments = [0, 4, 9]
    expect(playStage(moments, null)).toBeNull()
    expect(playStage(moments, 0)).toEqual({ cursor: 0, live: false })
    expect(playStage(moments, 2)).toEqual({ cursor: 1, live: true })
    expect(playStage(moments, 4)).toEqual({ cursor: 1, live: false })
    expect(playStage(moments, 7)).toEqual({ cursor: 2, live: true })
    expect(playStage(moments, 9)).toEqual({ cursor: 2, live: false })
  })

  it('la fila de «ahora» lleva lo que valía en ese fotograma, con encendido lo que ya es del final', () => {
    const live = withLive(content, 6, playStage([0, 4, 9], 6))
    // Las filas ya alcanzadas no cambian; la siguiente enseña la vuelta 6.
    expect(live.steps?.[1]).toEqual(content.steps[1])
    expect(live.steps?.[2]).toEqual({ label: '6', text: 'hkla', lit: [true, false, true, true] })
    // Justo en un momento, o sin reproducir, el visor es el de siempre.
    expect(withLive(content, 4, playStage([0, 4, 9], 4))).toBe(content)
    expect(withLive(content, null, null)).toBe(content)
  })

  it('lo mismo con una lista (sus barras) y con un tablero', () => {
    const bars = {
      title: 'x',
      strips: [
        { label: '0', values: [3, 1, 2] },
        { label: '2', values: [1, 2, 3] },
      ],
      film: {
        laps: [0, 1, 2],
        lists: [
          [3, 1, 2],
          [1, 3, 2],
          [1, 2, 3],
        ],
      },
    }
    expect(withLive(bars, 1, playStage([0, 2], 1)).strips?.[1]).toEqual({
      label: '1',
      values: [1, 3, 2],
      lit: [true, false, false],
    })
    const grid = (cell: number) => [[cell, 0]]
    const boards = {
      title: 'x',
      grids: [
        { label: '0', cells: grid(1) },
        { label: '2', cells: grid(0) },
      ],
      film: { laps: [0, 1, 2], boards: [grid(1), grid(2), grid(0)] },
    }
    expect(withLive(boards, 1, playStage([0, 2], 1)).grids?.[1]).toEqual({
      label: '1',
      cells: grid(2),
    })
  })
})
