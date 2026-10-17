import { describe, expect, it } from 'vitest'
import { answerTo, rejection } from '../webview/src/answering.ts'

/**
 * Con el micrófono abierto, lo que se dice no siempre es una orden nueva: puede ser la respuesta a una
 * pregunta del editor, o un «no, eso no» a lo que se acaba de hacer.
 */
describe('contestar de palabra a una pregunta', () => {
  const options = ['Sí, eliminar', 'Borrar solo validar_pin', 'Dejarlo como está']

  it('«sí» es la primera opción; «no», ninguna', () => {
    expect(answerTo('Sí', options)).toBe(0)
    expect(answerTo('vale', options)).toBe(0)
    expect(answerTo('No.', options)).toBe('no')
    expect(answerTo('déjalo', options)).toBe('no')
  })

  it('por su orden, o diciendo la opción', () => {
    expect(answerTo('la segunda', options)).toBe(1)
    expect(answerTo('la última', options)).toBe(2)
    expect(answerTo('opción dos', options)).toBe(1)
    expect(answerTo('borrar solo validar_pin', options)).toBe(1)
    expect(answerTo('dejarlo como está', options)).toBe(2)
  })

  it('lo que no contesta es otra cosa: una orden nueva', () => {
    expect(answerTo('crea una función que reste dos números', options)).toBeNull()
    expect(answerTo('ahora una clase calculadora con dos métodos', options)).toBeNull()
    expect(answerTo('sí', [])).toBeNull()
  })
})

describe('«no, eso no»', () => {
  it('rechaza lo último que se hizo', () => {
    expect(rejection('No, eso no')).toEqual({ then: '' })
    expect(rejection('así no')).toEqual({ then: '' })
    expect(rejection('deshazlo')).toEqual({ then: '' })
    expect(rejection('No era eso.')).toEqual({ then: '' })
  })

  it('y si trae la corrección detrás, es lo que se pide ahora (tal como se dijo)', () => {
    expect(rejection('No, eso no, que reste en vez de sumar')).toEqual({
      then: 'que reste en vez de sumar',
    })
    expect(rejection('así no: valídalo en la misma función')).toEqual({
      then: 'valídalo en la misma función',
    })
  })

  it('una orden que empieza por «no» no es un rechazo', () => {
    expect(rejection('no permitas más de tres intentos')).toBeNull()
    expect(rejection('crea una función')).toBeNull()
  })
})
