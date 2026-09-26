import type { Role } from '@prysel/morphology'
import type { SemanticEdge, SemanticGraph, SemanticNode, Size } from './types.ts'

/**
 * Generador de programas sintéticos con la forma de un script de Python real:
 * una cadena principal salpicada de decisiones que vuelven a juntarse, bucles,
 * constantes que usa medio programa e imports al principio.
 *
 * Existe para una sola cosa: comprobar que el diagrama se sigue entendiendo cuando
 * el programa deja de tener seis nodos. Es determinista, así que sirve de test de regresión.
 */

export interface GenerateOptions {
  /** Cuántos pasos tiene la cadena principal. */
  steps: number
  seed?: number
  /** Tamaño de un nodo; por defecto, el de una tarjeta en densidad normal. */
  size?: Size
  /** Cada cuántos pasos aparece una decisión que se abre y se vuelve a juntar. */
  branchEvery?: number
  /** Cada cuántos pasos aparece un bucle. */
  loopEvery?: number
  /** Cuántas constantes globales hay, y a cuántos pasos alimenta cada una. */
  constants?: number
  /**
   * Emite también el orden de ejecución (`sequence`), las ramas con su etiqueta y el dueño de cada paso de
   * una rama, como hace el analizador: es lo que lee el diagrama de flujo. Las constantes van al principio.
   */
  order?: boolean
}

const DEFAULTS = {
  seed: 7,
  size: { w: 258, h: 156 },
  branchEvery: 6,
  loopEvery: 11,
  constants: 2,
}

export function generateProgram(options: GenerateOptions): SemanticGraph {
  const { steps, seed, size, branchEvery, loopEvery, constants } = { ...DEFAULTS, ...options }
  const order = options.order === true
  const seq = (from: string, to: string) => {
    if (order) edges.push({ from, to, relation: 'sequence' })
  }
  let state = seed
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }

  const nodes: SemanticNode[] = []
  const edges: SemanticEdge[] = []
  const add = (id: string, role: Role, owner?: string) => {
    nodes.push({ id, role, size, ...(order && owner !== undefined ? { owner } : {}) })
    return id
  }

  // Imports: entran por referencia, no transportan datos.
  const imports = [add('import:pandas', 'external'), add('import:numpy', 'external')]

  let previous = add('step:0', 'effect')
  for (const id of imports) {
    edges.push({ from: id, to: previous, relation: 'reference' })
  }
  // En orden: los imports, las constantes y después el primer paso.
  const opening = [
    ...imports,
    ...Array.from({ length: constants }, (_, c) => `CONST_${c}`),
    previous,
  ]
  opening.slice(1).forEach((id, i) => {
    seq(opening[i] ?? id, id)
  })

  const consumers: string[] = []

  for (let i = 1; i <= steps; i++) {
    if (i % branchEvery === 0) {
      // Una decisión que se abre en dos y vuelve a juntarse: el caso más común en un script.
      const condition = add(`if:${i}`, 'control')
      edges.push({ from: previous, to: condition, relation: 'transform', toPort: 'field' })
      seq(previous, condition)
      const yes = add(`then:${i}`, 'transform', condition)
      const no = add(`else:${i}`, 'transform', condition)
      edges.push({ from: condition, to: yes, relation: 'branch', label: 'sí' })
      edges.push({ from: condition, to: no, relation: 'branch', label: 'no', fromPort: 'alt' })
      const join = add(`join:${i}`, 'transform')
      edges.push({ from: yes, to: join, relation: 'merge' })
      edges.push({ from: no, to: join, relation: 'merge' })
      seq(yes, join)
      seq(no, join)
      previous = join
      consumers.push(condition)
      continue
    }

    if (i % loopEvery === 0) {
      // Un bucle de dos pasos que se cierra sobre su cabecera.
      const head = add(`for:${i}`, 'control')
      edges.push({ from: previous, to: head, relation: 'transform', toPort: 'iterable' })
      seq(previous, head)
      const body = add(`body:${i}`, 'transform')
      const tail = add(`acc:${i}`, 'transform')
      edges.push({ from: head, to: body, relation: 'transform' })
      edges.push({ from: body, to: tail, relation: 'transform' })
      edges.push({ from: tail, to: head, relation: 'feedback' })
      seq(head, body)
      seq(body, tail)
      const after = add(`after:${i}`, 'transform')
      edges.push({ from: tail, to: after, relation: 'transform' })
      seq(tail, after)
      previous = after
      continue
    }

    const role: Role = rand() < 0.2 ? 'data' : 'transform'
    const step = add(`step:${i}`, role)
    edges.push({ from: previous, to: step, relation: 'transform' })
    seq(previous, step)
    previous = step
    if (rand() < 0.35) consumers.push(step)
  }

  add('display', 'output')
  edges.push({ from: previous, to: 'display', relation: 'transform' })
  seq(previous, 'display')

  // Constantes globales: el caso que produce un abanico y ensancha una capa.
  for (let c = 0; c < constants; c++) {
    const id = add(`CONST_${c}`, 'value')
    const targets = consumers.filter((_, i) => i % constants === c).slice(0, 4)
    for (const target of targets) {
      edges.push({ from: id, to: target, relation: 'dependency', toPort: 'value' })
    }
  }

  return { nodes, edges }
}
