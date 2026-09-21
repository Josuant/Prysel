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
})
