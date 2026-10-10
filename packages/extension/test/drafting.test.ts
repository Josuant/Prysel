import { describe, expect, it } from 'vitest'
import { draftOf, sketchOf } from '../webview/src/drafting.ts'

/**
 * La caja de lo que se está pidiendo se rellena con lo que la frase ya dice, palabra a palabra: su nombre,
 * lo que recibe y lo que hace. Lo que aún no se ha dicho no se inventa.
 */
describe('lo que ya se sabe de una pieza mientras se pide', () => {
  it('se va sabiendo más con cada palabra', () => {
    expect(draftOf('funcion', 'una función')).toEqual({ does: 'una función' })
    expect(draftOf('funcion', 'una función sumar')).toEqual({
      name: 'sumar',
      does: 'una función sumar',
    })
    expect(draftOf('funcion', 'una función sumar que sume dos números')).toEqual({
      name: 'sumar',
      takes: ['número 1', 'número 2'],
      does: 'sume dos números',
    })
  })

  it('«una función que…» aún no tiene nombre: no se toma «que» por uno', () => {
    expect(draftOf('funcion', 'una función que calcule la media')).toEqual({
      does: 'calcule la media',
    })
  })

  it('el nombre de una clase va con mayúscula, y se entiende «llamada»', () => {
    expect(draftOf('clase', 'crea una clase animal').name).toBe('Animal')
    expect(draftOf('clase', 'una clase llamada cajero automático').name).toBe('Cajero')
    expect(draftOf('funcion', 'un método que se llame validar_pin').name).toBe('validar_pin')
  })

  it('lo que recibe, si se dice', () => {
    expect(draftOf('funcion', 'una función saludar que reciba nombre y edad').takes).toEqual([
      'nombre',
      'edad',
    ])
    expect(draftOf('funcion', 'una función que reciba un texto').takes).toEqual(['texto'])
    expect(draftOf('funcion', 'una función sumar').takes).toBeUndefined()
  })

  it('sin la palabra que nombra la pieza, se queda con lo dicho', () => {
    expect(draftOf('programa', 'quiero algo que juegue solo')).toEqual({
      does: 'quiero algo que juegue solo',
    })
  })
})

describe('el esbozo de lo que se está escribiendo', () => {
  it('la cosa que se pide, y las partes que la frase ya nombra', () => {
    expect(
      sketchOf(
        'Quiero una lista de tareas donde pueda añadir, marcar como hechas y ver las pendientes',
      ),
    ).toEqual({
      what: 'una lista de tareas',
      parts: ['añadir', 'marcar como hechas', 'ver las pendientes'],
    })
    expect(sketchOf('Hazme un juego de adivinar un número del 1 al 100')).toEqual({
      what: 'un juego de adivinar un número del 1 al 100',
      parts: [],
    })
  })

  it('crece con lo que se va escribiendo: la última parte, aunque esté a medias', () => {
    expect(sketchOf('Quiero una lista')).toEqual({ what: 'una lista', parts: [] })
    expect(sketchOf('Quiero una lista de tareas con fechas y prio')?.parts).toEqual([
      'fechas',
      'prio',
    ])
  })

  it('sin nada dicho todavía, no hay esbozo', () => {
    expect(sketchOf('')).toBeNull()
    expect(sketchOf('Quiero ')).toBeNull()
    expect(sketchOf('haz')).toBeNull()
  })
})
