import { describe, expect, it } from 'vitest'
import { accepts, slotAccepts, slotTypeOf, valueTypeOf, type ControlModel } from '../src/index.ts'

const expression = (operator: string): ControlModel => ({
  kind: 'expression',
  left: 'a',
  operator,
  right: 'b',
  operators: [operator],
})

describe('qué clase de valor sale de un nodo', () => {
  it('un literal es lo que es', () => {
    expect(valueTypeOf('value.number', { kind: 'number', value: 1 })).toBe('number')
    expect(valueTypeOf('value.str', { kind: 'text', value: 'a' })).toBe('text')
    expect(valueTypeOf('value.bool', { kind: 'boolean', value: true })).toBe('boolean')
    expect(valueTypeOf('data.list', { kind: 'list', items: [] })).toBe('collection')
    expect(valueTypeOf('data.dict', { kind: 'dict', entries: [] })).toBe('collection')
  })

  it('el resultado de una conversión o de pedir un dato', () => {
    const call = (target: string): ControlModel => ({ kind: 'args', target, args: [] })
    expect(valueTypeOf('transform.call', call('float'))).toBe('number')
    expect(valueTypeOf('transform.call', call('len'))).toBe('number')
    expect(valueTypeOf('effect.io', call('input'))).toBe('text')
    expect(valueTypeOf('transform.call', call('sorted'))).toBe('collection')
    expect(valueTypeOf('transform.call', call('bool'))).toBe('boolean')
    expect(valueTypeOf('transform.call', call('algo_mio'))).toBe('any')
  })

  it('una comparación es booleana; una resta, numérica; una suma, según lo que sume', () => {
    expect(valueTypeOf('transform.operation', expression('<'))).toBe('boolean')
    expect(valueTypeOf('transform.operation', expression('-'))).toBe('number')
    expect(valueTypeOf('transform.operation', expression('+'))).toBe('any')
    expect(valueTypeOf('transform.operation', expression('*'))).toBe('any')
  })

  it('sin editor, manda el tipo del nodo; sin nada, es cualquiera', () => {
    expect(valueTypeOf('value.number')).toBe('number')
    expect(valueTypeOf('opaque.code')).toBe('any')
  })
})

describe('qué acepta un campo', () => {
  it('los operandos de una resta piden un número; los de una suma, cualquier cosa', () => {
    expect(slotAccepts(expression('-'), 'left')).toContain('number')
    expect(slotAccepts(expression('+'), 'left')).toBeUndefined()
  })

  it('no se conecta un texto a una resta, pero sí a una suma', () => {
    expect(accepts(expression('-'), 'right', 'text')).toBe(false)
    expect(accepts(expression('-'), 'right', 'collection')).toBe(false)
    expect(accepts(expression('-'), 'right', 'number')).toBe(true)
    // Un booleano es un entero en Python.
    expect(accepts(expression('-'), 'right', 'boolean')).toBe(true)
    expect(accepts(expression('+'), 'right', 'text')).toBe(true)
  })

  it('lo que no se sabe se acepta: Python es dinámico', () => {
    expect(accepts(expression('-'), 'right', 'any')).toBe(true)
  })

  it('la secuencia de un bucle pide algo que se pueda recorrer', () => {
    const loop: ControlModel = { kind: 'loop', variable: 'i', iterable: 'x' }
    expect(accepts(loop, 'iterable', 'collection')).toBe(true)
    expect(accepts(loop, 'iterable', 'text')).toBe(true)
    expect(accepts(loop, 'iterable', 'number')).toBe(false)
  })

  it('el color de un puerto de entrada es lo que pide', () => {
    expect(slotTypeOf(expression('-'), 'left')).toBe('number')
    expect(slotTypeOf({ kind: 'loop', variable: 'i', iterable: 'x' }, 'iterable')).toBe(
      'collection',
    )
    expect(slotTypeOf(expression('+'), 'left')).toBe('any')
  })
})
