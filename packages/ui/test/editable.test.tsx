import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Control, type ControlModel } from '../src/index.ts'

/**
 * Un editor se puede escribir de vuelta en el código solo donde el analizador sabe dónde está
 * el campo en el texto. Lo demás se ve, pero no se toca: un campo que acepta texto y no cambia
 * el programa engaña.
 */

const html = (
  model: ControlModel,
  props: { editable?: string[]; onChange?: boolean; level?: 'summary' | 'full' } = {},
) =>
  renderToStaticMarkup(
    <Control
      model={model}
      level={props.level ?? 'summary'}
      {...(props.onChange === false ? {} : { onChange: () => undefined })}
      {...(props.editable ? { editable: props.editable } : {})}
    />,
  )

/** Cuántos campos de texto salen de solo lectura. */
const readOnly = (markup: string) => (markup.match(/readOnly=""|readonly=""/g) ?? []).length
const inputs = (markup: string) => (markup.match(/<input/g) ?? []).length
const disabled = (markup: string) => (markup.match(/disabled=""/g) ?? []).length

const expression: ControlModel = {
  kind: 'expression',
  left: 'a',
  operator: '+',
  right: 'b',
  operators: ['+', '-'],
}

describe('qué campos de un editor se pueden escribir', () => {
  it('sin lista, todos (un editor de ejemplo, sin código detrás)', () => {
    const markup = html(expression)
    expect(readOnly(markup)).toBe(0)
    expect(disabled(markup)).toBe(0)
  })

  it('con lista, solo los que ella dice', () => {
    const markup = html(expression, { editable: ['left'] })
    // Dos campos de texto (izquierda y derecha), y solo la derecha queda de solo lectura…
    expect(inputs(markup)).toBe(2)
    expect(readOnly(markup)).toBe(1)
    // …y el operador, que tampoco está en la lista, no se puede cambiar.
    expect(disabled(markup)).toBe(1)
  })

  it('con todos los campos en la lista, todo se puede tocar', () => {
    const markup = html(expression, { editable: ['left', 'operator', 'right'] })
    expect(readOnly(markup)).toBe(0)
    expect(disabled(markup)).toBe(0)
  })

  it('con la lista vacía, nada', () => {
    const markup = html(expression, { editable: [] })
    expect(readOnly(markup)).toBe(2)
    expect(disabled(markup)).toBe(1)
  })

  it('sin quien reciba el cambio, todo es de solo lectura', () => {
    const markup = html(expression, { onChange: false })
    expect(readOnly(markup)).toBe(2)
    expect(disabled(markup)).toBe(1)
  })

  it('un argumento se edita por su nombre', () => {
    const call: ControlModel = {
      kind: 'args',
      target: 'suma',
      args: [
        { name: 'a', value: 'x' },
        { name: 'b', value: 'y' },
      ],
    }
    const markup = html(call, { editable: ['args.b'], level: 'full' })
    // En el editor completo se ven la función y los dos argumentos; solo `b` se puede escribir.
    expect(inputs(markup)).toBe(3)
    expect(readOnly(markup)).toBe(2)
  })

  it('un valor por defecto y un nombre de parámetro son campos distintos', () => {
    const signature: ControlModel = {
      kind: 'signature',
      params: [{ name: 'tope', value: '3' }],
    }
    // Dos campos por parámetro (nombre y valor): con solo el valor editable, el nombre queda de solo lectura.
    expect(readOnly(html(signature, { editable: ['params.tope'] }))).toBe(1)
    expect(readOnly(html(signature, { editable: ['params.tope', 'params[0].name'] }))).toBe(0)
    expect(readOnly(html(signature, { editable: [] }))).toBe(2)
  })

  it('la variable de un bucle no se edita aunque su secuencia sí', () => {
    const loop: ControlModel = { kind: 'loop', iterable: 'xs', variable: 'x' }
    const markup = html(loop, { editable: ['iterable'] })
    expect(inputs(markup)).toBe(2)
    expect(readOnly(markup)).toBe(1)
  })
})

describe('un editor que el código no sabe reescribir', () => {
  // Un editor que el analizador no produce (una constante): no sabe escribirse de vuelta.
  const list: ControlModel = { kind: 'constant', value: 'None', options: ['None', '0'] }

  it('con una lista de campos editables, se congela entero', () => {
    expect(html(list, { editable: [] })).toContain('<fieldset class="control-frozen" disabled="">')
  })

  it('sin lista (un ejemplo), sigue siendo un editor normal', () => {
    expect(html(list)).not.toContain('control-frozen')
  })

  it('uno que sí sabe escribirse no se congela', () => {
    expect(html(expression, { editable: [] })).not.toContain('control-frozen')
  })
})
