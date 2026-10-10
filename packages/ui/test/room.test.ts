import { describe, expect, it } from 'vitest'
import { roomFor } from '../src/fit.ts'

/**
 * La consola ocupa un rincón del lienzo: el diagrama se encuadra en lo que queda, a su lado o por encima,
 * según dónde se vea más grande.
 */
describe('el sitio que deja la consola', () => {
  const frame = { w: 1000, h: 600 }
  const corner = { w: 320, h: 260 }

  it('sin consola, el lienzo entero', () => {
    expect(roomFor(frame, { w: 900, h: 400 }, null)).toBe(frame)
  })

  it('un diagrama ancho y bajo se queda por encima de la consola: no pierde ancho', () => {
    expect(roomFor(frame, { w: 1400, h: 300 }, corner)).toEqual({ w: 1000, h: 340 })
  })

  it('uno alto y estrecho se queda a su lado: no pierde alto', () => {
    expect(roomFor(frame, { w: 500, h: 900 }, corner)).toEqual({ w: 680, h: 600 })
  })

  it('si la consola no deja sitio útil a ningún lado, no se le hace hueco', () => {
    expect(roomFor({ w: 400, h: 300 }, { w: 500, h: 400 }, corner)).toEqual({ w: 400, h: 300 })
  })
})
