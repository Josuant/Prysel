import { describe, expect, it } from 'vitest'
import {
  isLineCard,
  labelsArgs,
  lineArgs,
  lineHeight,
  lineWidth,
  slimHeight,
  type ControlModel,
} from '../src/index.ts'

/**
 * Una operación o una llamada se dibujan en una sola línea: icono, nombre, y lo que hacen al lado.
 */

const formula = (left: string, right: string): ControlModel => ({
  kind: 'expression',
  left,
  operator: '+',
  right,
  operators: ['+'],
})
const call = (target: string, ...names: string[]): ControlModel => ({
  kind: 'args',
  target,
  args: names.map((name, index) => ({ name, value: String(index) })),
})

describe('qué se dibuja en una línea', () => {
  it('las operaciones y las llamadas con su editor', () => {
    expect(isLineCard('transform.operation', formula('a', 'b'))).toBe(true)
    expect(isLineCard('transform.call', call('suma', 'a', 'b'))).toBe(true)
    expect(isLineCard('effect.io', call('print', 'arg1'))).toBe(true)
  })

  it('lo demás sigue apilando cabecera y editor', () => {
    expect(isLineCard('control.condition', formula('a', 'b'))).toBe(false)
    expect(isLineCard('transform.operation', undefined)).toBe(false)
    expect(isLineCard('value.number', { kind: 'number', value: 1 })).toBe(false)
  })
})

describe('los argumentos de una línea', () => {
  it('solo se rotulan los que tienen nombre propio', () => {
    expect(labelsArgs([{ name: 'arg1' }, { name: 'arg2' }])).toBe(false)
    expect(labelsArgs([{ name: 'a' }, { name: 'b' }])).toBe(true)
    // Con uno solo no hace falta: no hay confusión posible.
    expect(labelsArgs([{ name: 'a' }])).toBe(false)
    expect(labelsArgs([{ name: 'valor' }, { name: 'arg2' }])).toBe(false)
  })

  it('con pocos se enseñan todos; con muchos, el primero y los conectados', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name }))
    expect(lineArgs(many.slice(0, 4)).hidden).toBe(0)
    expect(lineArgs(many)).toMatchObject({ hidden: 4 })
    expect(lineArgs(many, ['arg:c']).shown.map((arg) => arg.name)).toEqual(['a', 'c'])
  })
})

describe('lo que mide una línea', () => {
  it('es una fila: mucho menos alta que la tarjeta apilada', () => {
    expect(lineHeight()).toBeLessThan(slimHeight(formula('a', 'b')))
    expect(lineHeight()).toBe(56)
  })

  it('un comentario suma su sitio bajo la línea', () => {
    expect(lineHeight('explica esto')).toBeGreaterThan(lineHeight())
  })

  it('crece con lo que lleva escrito', () => {
    expect(lineWidth(formula('unnombremuylargo', 'b'), 'r')).toBeGreaterThan(
      lineWidth(formula('a', 'b'), 'r'),
    )
    expect(lineWidth(call('suma', 'a', 'b'), 'x')).toBeGreaterThan(
      lineWidth(call('suma', 'a'), 'x'),
    )
  })

  it('el nombre que asigna ocupa sitio; el chevron que abre la función también', () => {
    expect(lineWidth(formula('a', 'b'), 'resultado')).toBeGreaterThan(
      lineWidth(formula('a', 'b'), undefined),
    )
    expect(lineWidth(call('suma', 'a', 'b'), 'x', [], 26)).toBe(
      lineWidth(call('suma', 'a', 'b'), 'x') + 26,
    )
  })

  it('una llamada de acción no repite su nombre en un campo', () => {
    expect(lineWidth(call('print', 'arg1'), undefined)).toBeLessThan(
      lineWidth(call('imprime_todo', 'arg1'), undefined),
    )
  })
})
