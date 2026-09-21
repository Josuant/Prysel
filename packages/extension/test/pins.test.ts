import { describe, expect, it } from 'vitest'
import type { RunView } from '../src/runs.ts'
import {
  FIGURE,
  MAX_PINS,
  contentOf,
  pinNodeId,
  pngSize,
  resolvePins,
  togglePin,
  viewableOf,
  type PinKey,
} from '../webview/src/pins.ts'

/**
 * Los visores fijados: a qué sentencia siguen tras editar, qué se puede ver de una ejecución y qué
 * enseña cada uno. Un visor no toca el código: solo se recuerda en el lienzo.
 */

const view = (over: Partial<RunView> = {}): RunView => ({
  state: 'fresh',
  hash: 'h1',
  seq: 3,
  ...over,
})

/** Un PNG mínimo válido en Base64 (solo su cabecera: lo justo para leer el tamaño). */
const png = (w: number, h: number): string => {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, w)
  new DataView(bytes.buffer).setUint32(20, h)
  return btoa(String.fromCharCode(...bytes))
}

describe('el tamaño de un PNG', () => {
  it('se lee de su cabecera', () => {
    expect(pngSize(png(640, 480))).toEqual({ w: 640, h: 480 })
    expect(pngSize(png(1, 90000))).toEqual({ w: 1, h: 90000 })
  })

  it('lo que no es un PNG no da tamaño', () => {
    expect(pngSize(btoa('esto no es una imagen, ni de lejos'))).toBeNull()
    expect(pngSize('%%%')).toBeNull()
    expect(pngSize('')).toBeNull()
  })
})

describe('a qué sentencia sigue un visor', () => {
  const key: PinKey = { id: 'assign:5:0', hash: 'h1', name: 'X' }

  it('a la que conserva su texto, aunque se haya movido de línea', () => {
    const runs = { 'assign:9:0': view({ hash: 'h1' }), 'assign:5:0': view({ hash: 'otro' }) }
    expect(resolvePins([key], runs)[0]?.statement).toBe('assign:9:0')
  })

  it('si se editó por dentro, a la que está en el mismo sitio', () => {
    const runs = { 'assign:5:0': view({ state: 'never', hash: 'cambiado' }) }
    expect(resolvePins([key], runs)[0]?.statement).toBe('assign:5:0')
  })

  it('si la sentencia ya no existe, el visor no se enseña (pero sigue recordado)', () => {
    expect(resolvePins([key], { 'assign:1:0': view({ hash: 'x' }) })).toEqual([])
  })
})

describe('qué se puede ver', () => {
  it('los valores con forma y las figuras; un módulo, una función o None no', () => {
    const v = view({
      values: {
        X: { type: 'ndarray', module: 'numpy', shape: [2, 2] },
        np: { type: 'module', module: 'builtins', repr: 'numpy' },
        f: { type: 'function', module: 'builtins' },
        nada: { type: 'NoneType', module: 'builtins' },
        n: { type: 'int', module: 'builtins', repr: '3' },
      },
    })
    const assets = { figures: [{ mime: 'image/png', data: png(10, 10) }], images: {} }
    expect(viewableOf(v, assets)).toEqual(['X', 'n', `${FIGURE}0`])
    expect(viewableOf(v, undefined)).toEqual(['X', 'n'])
  })
})

describe('lo que enseña un visor', () => {
  const key = (name: string): PinKey => ({ id: 's', hash: 'h1', name })

  it('una tabla, con sus columnas y filas', () => {
    const content = contentOf(
      key('df'),
      view({
        values: {
          df: {
            type: 'DataFrame',
            module: 'pandas',
            shape: [3, 2],
            table: {
              columns: [{ name: 'a', dtype: 'int64', nulls: 1 }],
              rows: [[1], [null], [{ raro: true }]],
            },
          },
        },
      }),
      undefined,
    )
    expect(content.subtitle).toBe('DataFrame 3×2')
    expect(content.table?.rows).toEqual([[1], [null], ['[object Object]']])
  })

  it('un array: su muestra y su rango', () => {
    const content = contentOf(
      key('X'),
      view({
        values: {
          X: {
            type: 'ndarray',
            module: 'numpy',
            shape: [3, 4],
            dtype: 'float32',
            sample: [0, 1, 2],
            range: [0, 11],
          },
        },
      }),
      undefined,
    )
    expect(content.subtitle).toBe('ndarray 3×4 float32')
    expect(content.text).toEqual(['0, 1, 2, …', 'rango [0, 11]'])
  })

  it('una lista: sus elementos y cuántos faltan', () => {
    const content = contentOf(
      key('xs'),
      view({ values: { xs: { type: 'list', module: 'builtins', length: 14, items: ['1', '2'] } } }),
      undefined,
    )
    expect(content.text).toEqual(['1', '2', '… 12 más'])
  })

  it('una figura: su imagen, con su tamaño', () => {
    const data = png(800, 600)
    const content = contentOf(key(`${FIGURE}0`), view(), {
      figures: [{ mime: 'image/png', data }],
      images: {},
    })
    expect(content.title).toBe('figura')
    expect(content.image).toMatchObject({ w: 800, h: 600 })
    expect(content.image?.src.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('una imagen de un valor: su miniatura', () => {
    const content = contentOf(
      key('img'),
      view({ values: { img: { type: 'Image', module: 'PIL', size: [64, 32] } } }),
      { figures: [], images: { img: png(64, 32) } },
    )
    expect(content.image).toMatchObject({ w: 64, h: 32 })
  })

  it('un resultado que quedó atrás se marca como desactualizado', () => {
    const content = contentOf(
      key('n'),
      view({ state: 'stale', values: { n: { type: 'int', module: 'builtins', repr: '3' } } }),
      undefined,
    )
    expect(content.stale).toBe(true)
    expect(content.text).toEqual(['3'])
  })

  it('sin ejecutar, lo dice; y lo que ya no existe, también', () => {
    expect(contentOf(key('n'), view({ state: 'never' }), undefined).subtitle).toBe('sin ejecutar')
    expect(contentOf(key('n'), view({ values: {} }), undefined).text?.[0]).toMatch(/ya no deja/)
    expect(contentOf(key(`${FIGURE}2`), view(), { figures: [], images: {} }).text?.[0]).toMatch(
      /ya no está/,
    )
  })
})

describe('fijar y quitar', () => {
  const a: PinKey = { id: 's1', hash: 'h1', name: 'X' }
  const b: PinKey = { id: 's2', hash: 'h2', name: 'y' }

  it('fijar dos veces el mismo valor lo quita', () => {
    expect(togglePin([], a)).toEqual([a])
    expect(togglePin([a, b], a)).toEqual([b])
  })

  it('el mismo valor en otra posición sigue siendo el mismo visor', () => {
    expect(togglePin([a], { ...a, id: 'otro-id' })).toEqual([])
  })

  it('recuerda un número acotado de visores', () => {
    const many = Array.from({ length: MAX_PINS }, (_, i) => ({
      id: `s${i}`,
      hash: `h${i}`,
      name: 'v',
    }))
    const next = togglePin(many, a)
    expect(next).toHaveLength(MAX_PINS)
    expect(next.at(-1)).toEqual(a)
  })

  it('cada visor tiene su propio id de nodo', () => {
    expect(pinNodeId(a)).not.toBe(pinNodeId(b))
    expect(pinNodeId(a)).toMatch(/^pin:/)
  })
})
