import { describe, expect, it } from 'vitest'
import {
  ACTION_CALLS,
  accepts,
  slimControlHeight,
  slimHeight,
  slimWidth,
  slotAccepts,
  slotTypeOf,
  valueTypeOf,
  type ControlModel,
} from '../src/index.ts'

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

describe('la tarjeta esbelta mide lo que lleva dentro', () => {
  const row = slimControlHeight({ kind: 'number', value: 1 })
  const args = (target: string, names: string[]): ControlModel => ({
    kind: 'args',
    target,
    args: names.map((name) => ({ name, value: 'x' })),
  })

  it('un editor de una fila es una fila', () => {
    expect(slimControlHeight({ kind: 'text', value: 'Hola', multiline: false })).toBe(row)
  })

  it('una operación y una condición caben en una fila: A, operador y B', () => {
    const operation: ControlModel = {
      kind: 'expression',
      left: 'a',
      operator: '+',
      right: 'b',
      operators: ['+'],
    }
    expect(slimControlHeight(operation)).toBe(row)
    expect(
      slimControlHeight({
        kind: 'condition',
        field: 'a',
        operator: '<',
        value: '1',
        operators: ['<'],
      }),
    ).toBe(row)
  })

  it('una llamada suma la función y cada argumento; print no repite su nombre', () => {
    expect(slimControlHeight(args('sumar', ['a', 'b']))).toBeGreaterThan(
      slimControlHeight(args('print', ['mensaje', 'fin'])),
    )
    // print(x): un solo campo, el del mensaje.
    expect(slimControlHeight(args('print', ['mensaje']))).toBe(row)
    expect(ACTION_CALLS.has('print')).toBe(true)
  })

  it('con más argumentos de los que caben, los que no tienen cable se resumen', () => {
    const many = args('f', ['a', 'b', 'c', 'd', 'e', 'f'])
    expect(slimControlHeight(many)).toBeLessThan(
      slimControlHeight(args('f', ['a', 'b', 'c', 'd'])) + 40,
    )
  })

  it('el alto total es marco + cabecera + editor: sin aire de más', () => {
    const one = slimHeight({ kind: 'number', value: 1 })
    const two = slimHeight(args('sumar', ['a', 'b']))
    expect(two - one).toBe(slimControlHeight(args('sumar', ['a', 'b'])) - row)
    // Y es bastante menos que la tarjeta de antes (156 de base).
    expect(one).toBeLessThan(100)
  })

  it('un comentario suma su sitio; sin editor, se enseña el código', () => {
    expect(slimHeight({ kind: 'number', value: 1 }, [], 'Explica algo')).toBeGreaterThan(
      slimHeight({ kind: 'number', value: 1 }),
    )
    expect(slimHeight(undefined, [], undefined, true)).toBeGreaterThan(slimHeight(undefined))
  })

  it('las fórmulas piden más ancho que un campo suelto', () => {
    const formula: ControlModel = {
      kind: 'condition',
      field: 'a',
      operator: '<',
      value: '1',
      operators: ['<'],
    }
    expect(slimWidth(224, formula)).toBeGreaterThan(224)
    expect(slimWidth(224, { kind: 'number', value: 1 })).toBe(224)
    expect(slimWidth(300, formula)).toBe(300)
  })
})
