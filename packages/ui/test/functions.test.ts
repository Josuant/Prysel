import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../src/Canvas.tsx'
import { functionsOf } from '../src/program.ts'

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: 'abstraction.collapsed',
  label: id,
  ...extra,
})

describe('las funciones que se ofrecen', () => {
  const clase = node('Perro', {
    kind: 'abstraction.class',
    contains: ['init', 'ladrar', 'dentro'],
    control: { kind: 'class', bases: '', params: ['nombre', 'edad'] },
  })
  const init = node('init', { owner: 'Perro', contains: ['dentro'], label: '__init__' })
  const ladrar = node('ladrar', { owner: 'Perro', contains: ['dentro'] })
  const suelta = node('suma', {
    contains: ['dentro'],
    control: { kind: 'signature', params: [{ name: 'a', value: '' }] },
  })
  const nodes = [clase, init, ladrar, suelta, node('dentro', { kind: 'transform.call' })]

  it('una clase se llama como una función, con los parámetros de su __init__', () => {
    const perro = functionsOf(nodes, []).find((f) => f.name === 'Perro')
    expect(perro).toMatchObject({ signature: '(nombre, edad)', params: ['nombre', 'edad'] })
  })

  it('un método vive dentro de su clase: no se ofrece como función suelta', () => {
    expect(functionsOf(nodes, []).map((f) => f.name)).toEqual(['Perro', 'suma'])
  })

  it('una función anidada sabe dentro de qué función vive, aunque haya un bucle en medio', () => {
    const exterior = node('exterior', { contains: ['bucle', 'doble'] })
    const bucle = node('bucle', { kind: 'control.loop', owner: 'exterior', contains: ['doble'] })
    const doble = node('doble', { owner: 'bucle', contains: ['cuerpo'] })
    const cuerpo = node('cuerpo', { kind: 'control.return', owner: 'doble' })
    const found = functionsOf([exterior, bucle, doble, cuerpo], [])
    expect(found.find((f) => f.name === 'doble')?.scope).toBe('exterior')
    // Una función del programa no tiene ámbito: se ofrece en la cajita del programa.
    expect(found.find((f) => f.name === 'exterior')?.scope).toBeUndefined()
  })
})
