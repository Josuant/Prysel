import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../src/Canvas.tsx'
import { iterChipId } from '../src/chips.ts'
import { chipSource } from '../src/flow/useChipDrag.ts'
import { addPlace, checkConnection, connectAction, dropTarget, outputName } from '../src/connect.ts'

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: 'transform.operation',
  label: id,
  ...extra,
})

const NODES = new Map<string, CanvasNode>(
  [
    node('a', { provides: 'a', valueType: 'number', scope: [] }),
    node('texto', { provides: 'texto', valueType: 'text', scope: ['a'] }),
    node('resta', {
      provides: 'resta',
      inputs: ['left', 'right'],
      scope: ['a', 'texto'],
      control: { kind: 'expression', left: 'a', operator: '-', right: 'a', operators: ['-'] },
    }),
    node('suma', {
      provides: 'suma',
      inputs: ['left', 'right'],
      scope: ['a', 'texto', 'resta'],
      control: { kind: 'expression', left: 'a', operator: '+', right: 'a', operators: ['+'] },
    }),
    node('print', { kind: 'effect.io', scope: ['a'] }),
    node('def', { kind: 'abstraction.collapsed', provides: 'f', params: ['p', 'q'] }),
    node('dentro', { inputs: ['left'], scope: ['a', 'f', 'p', 'q'] }),
    node('fuera', { inputs: ['left'], scope: ['a', 'f'] }),
    node('bucle', { kind: 'control.loop', provides: 'i' }),
  ].map((n) => [n.id, n]),
)

const get = (id: string): CanvasNode => {
  const found = NODES.get(id)
  if (!found) throw new Error(`sin nodo ${id}`)
  return found
}

describe('conectar un cable', () => {
  it('vale si el nombre está al alcance del destino y la clase encaja', () => {
    expect(checkConnection(NODES, { from: 'a', to: 'resta', slot: 'left' })).toEqual({
      ok: true,
      name: 'a',
    })
  })

  it('un nodo que no define nada no da valores', () => {
    const verdict = checkConnection(NODES, { from: 'print', to: 'resta', slot: 'left' })
    expect(verdict).toMatchObject({ ok: false })
  })

  it('un campo que no acepta cables se rechaza', () => {
    expect(checkConnection(NODES, { from: 'a', to: 'resta', slot: 'operator' })).toMatchObject({
      ok: false,
    })
  })

  it('un nodo no se alimenta a sí mismo', () => {
    expect(checkConnection(NODES, { from: 'resta', to: 'resta', slot: 'left' })).toMatchObject({
      ok: false,
    })
  })

  it('un valor que se define después, o en otro ámbito, no se ve desde el destino', () => {
    const verdict = checkConnection(NODES, { from: 'suma', to: 'resta', slot: 'left' })
    expect(verdict).toMatchObject({ ok: false })
    expect(verdict.ok ? '' : verdict.reason).toContain('suma')
  })

  it('un texto en una resta se convierte con float(); en una suma entra tal cual', () => {
    expect(checkConnection(NODES, { from: 'texto', to: 'resta', slot: 'right' })).toEqual({
      ok: true,
      name: 'texto',
      convert: 'float',
    })
    expect(checkConnection(NODES, { from: 'texto', to: 'suma', slot: 'right' })).toEqual({
      ok: true,
      name: 'texto',
    })
  })

  it('una colección en una resta no se convierte: se rechaza y se explica', () => {
    const all = new Map(NODES).set('lista', {
      id: 'lista',
      kind: 'data.list',
      label: 'lista',
      provides: 'lista',
      valueType: 'collection',
      scope: [],
    } as CanvasNode)
    const bad = checkConnection(
      new Map(all).set('resta', {
        ...(all.get('resta') as CanvasNode),
        scope: ['a', 'texto', 'lista'],
      }),
      { from: 'lista', to: 'resta', slot: 'right' },
    )
    expect(bad).toMatchObject({ ok: false })
    expect(bad.ok ? '' : bad.reason).toContain('colección')
  })

  it('la conversión viaja en la acción', () => {
    expect(connectAction({ from: 'a', to: 'b', slot: 'left', convert: 'float' })).toMatchObject({
      convert: 'float',
    })
  })
})

describe('los parámetros de una función', () => {
  it('cada uno sale por su puerto y se ve desde dentro', () => {
    expect(outputName(get('def'), 'param:q')).toBe('q')
    expect(
      checkConnection(NODES, { from: 'def', port: 'param:q', to: 'dentro', slot: 'left' }),
    ).toEqual({ ok: true, name: 'q' })
  })

  it('no se ve desde fuera de la función', () => {
    expect(
      checkConnection(NODES, { from: 'def', port: 'param:q', to: 'fuera', slot: 'left' }).ok,
    ).toBe(false)
  })

  it('un parámetro que no existe no sale', () => {
    expect(outputName(get('def'), 'param:z')).toBeUndefined()
  })

  it('el puerto normal de la función es su nombre', () => {
    expect(outputName(get('def'))).toBe('f')
  })
})

describe('el gesto se escribe como una acción', () => {
  it('lleva el puerto solo si es de un parámetro', () => {
    expect(connectAction({ from: 'a', to: 'b', slot: 'left' })).toEqual({
      type: 'connect',
      from: 'a',
      to: 'b',
      slot: 'left',
    })
    expect(connectAction({ from: 'a', port: 'param:p', to: 'b', slot: 'left' })).toMatchObject({
      port: 'param:p',
    })
  })
})

describe('dónde va lo que se crea al soltar un cable en el vacío', () => {
  it('detrás del nodo del que sale', () => {
    expect(dropTarget(get('a'))).toEqual({ after: 'a' })
  })

  it('dentro de la función si sale de un parámetro, y dentro del bucle si sale de su variable', () => {
    expect(dropTarget(get('def'), 'param:p')).toEqual({ into: 'def' })
    expect(dropTarget(get('bucle'))).toEqual({ into: 'bucle' })
  })
})

describe('el menú de añadir sabe dónde poner las cosas', () => {
  it('dentro de una función o un bucle seleccionados', () => {
    const fn = { id: 'def', kind: 'abstraction.collapsed', label: 'suma' }
    expect(addPlace(fn, null)).toEqual({ where: 'Dentro de «suma»', place: { into: 'def' } })
    const loop = { id: 'for', kind: 'control.loop', label: 'cada x' }
    expect(addPlace(loop, null).place).toEqual({ into: 'for' })
  })

  it('detrás de cualquier otro nodo', () => {
    expect(addPlace({ id: 'x', kind: 'value.number', label: 'x' }, null)).toEqual({
      where: 'Después de «x»',
      place: { after: 'x' },
    })
  })

  it('sin selección: al final de la función que se ve, o del programa', () => {
    expect(addPlace(undefined, { id: 'f', name: 'suma' })).toEqual({
      where: 'Al final de suma',
      place: { into: 'f' },
    })
    expect(addPlace(undefined, null)).toEqual({ where: 'Al final del programa', place: {} })
  })
})

describe('de dónde sale el valor de un chip', () => {
  it('la variable de un bucle sale por el puerto de su bucle', () => {
    expect(chipSource(iterChipId('for:2:0', 'n'))).toEqual({ from: 'for:2:0', port: 'param:n' })
  })

  it('una constante es su propio nodo, y una función su definición', () => {
    expect(chipSource('x')).toEqual({ from: 'x' })
    expect(chipSource('fn:def')).toEqual({ from: 'def' })
  })

  it('la variable de un bucle se conecta a lo que hay dentro, como un parámetro', () => {
    const all = new Map(NODES).set('for', node('for', { kind: 'control.loop', params: ['i'] }))
    all.set('dentro', node('dentro', { inputs: ['left'], scope: ['i'] }))
    expect(
      checkConnection(all, { ...chipSource(iterChipId('for', 'i')), to: 'dentro', slot: 'left' }),
    ).toEqual({ ok: true, name: 'i' })
  })
})
