import { VALUE_NAMES, accepts, type NodeAction } from '@prysel/morphology'
import type { CanvasNode } from './Canvas.tsx'

/**
 * ¿Se puede conectar esta salida a este campo? La respuesta la da el propio diagrama, antes de
 * escribir nada: un cable que escribiera un nombre que Python no conoce en ese punto, o un valor
 * que no vale en ese campo, rompería el programa.
 */

/** Los dos extremos de un cable: de qué puerto sale y a qué campo llega. */
export interface Link {
  from: string
  /** Un parámetro de función sale por su propio puerto (`param:a`); el resto, por el normal. */
  port?: string
  to: string
  slot: string
}

export type Verdict = { ok: true; name: string } | { ok: false; reason: string }

/** El nombre que sale por un puerto de un nodo, si sale alguno. */
export function outputName(node: CanvasNode, port?: string): string | undefined {
  if (port?.startsWith('param:')) {
    const name = port.slice('param:'.length)
    return node.params?.includes(name) ? name : undefined
  }
  return node.provides
}

export function checkConnection(nodes: ReadonlyMap<string, CanvasNode>, link: Link): Verdict {
  const source = nodes.get(link.from)
  const target = nodes.get(link.to)
  if (!source || !target) return { ok: false, reason: 'Ese nodo ya no está.' }
  if (link.slot === 'return') {
    // El puerto de retorno de una función: recibe lo que se calcula dentro de ella (o uno de sus parámetros).
    const name = outputName(source, link.port)
    const inside =
      target.contains?.includes(source.id) === true ||
      (source.id === target.id && link.port?.startsWith('param:') === true)
    if (!target.inputs?.includes('return') || !inside || name === undefined) {
      return {
        ok: false,
        reason: 'Solo se puede devolver un valor calculado dentro de la función.',
      }
    }
    return { ok: true, name }
  }
  if (source.id === target.id)
    return { ok: false, reason: 'Un nodo no puede alimentarse a sí mismo.' }
  if (!target.inputs?.includes(link.slot)) {
    return { ok: false, reason: 'Ese campo no recibe valores de otros nodos.' }
  }
  const name = outputName(source, link.port)
  if (name === undefined) return { ok: false, reason: 'Este nodo no produce ningún valor.' }
  // A quién se llama tiene que ser una función; a la inversa, una función sí puede pasarse como valor.
  if (link.slot === 'callee' && (source.kind !== 'abstraction.collapsed' || link.port)) {
    return { ok: false, reason: 'Solo una función se puede llamar.' }
  }
  if (!target.scope?.includes(name)) {
    return {
      ok: false,
      reason: `«${name}» no está definido antes de ese nodo, o no se ve desde él.`,
    }
  }
  const given = source.valueType ?? 'any'
  if (!accepts(target.control, link.slot, given)) {
    return { ok: false, reason: `No se puede conectar ${VALUE_NAMES[given]} a ese campo.` }
  }
  return { ok: true, name }
}

/** El gesto de conectar, como la acción que lo escribe en el código. */
export const connectAction = (link: Link): NodeAction => ({
  type: 'connect',
  from: link.from,
  to: link.to,
  slot: link.slot,
  ...(link.port === undefined ? {} : { port: link.port }),
})

/**
 * Dónde va lo que se crea al soltar un cable en el vacío. Lo que sale de un parámetro o de la
 * variable de un bucle solo existe **dentro** de su función o su bucle: ahí va lo nuevo. El resto,
 * justo detrás del nodo del que sale.
 */
export function dropTarget(
  source: CanvasNode,
  port?: string,
): { after: string } | { into: string } {
  const inside = port?.startsWith('param:') || source.kind === 'control.loop'
  return inside ? { into: source.id } : { after: source.id }
}

/**
 * Dónde va lo que se añade desde el menú: **dentro** del nodo seleccionado si es una función o un
 * bucle (es lo que se quiere al elegir un territorio y pulsar «Añadir»), detrás de cualquier otro,
 * al final de la función que se está viendo, o al final del archivo. También dice cómo contarlo.
 */
export function addPlace(
  anchor: { id: string; kind: string; label: string } | undefined,
  focus: { id: string; name: string } | null | undefined,
): { where: string; place: { after: string } | { into: string } | Record<string, never> } {
  if (anchor) {
    const territory = anchor.kind === 'abstraction.collapsed' || anchor.kind === 'control.loop'
    return territory
      ? { where: `Dentro de «${anchor.label}»`, place: { into: anchor.id } }
      : { where: `Después de «${anchor.label}»`, place: { after: anchor.id } }
  }
  return focus
    ? { where: `Al final de ${focus.name}`, place: { into: focus.id } }
    : { where: 'Al final del programa', place: {} }
}
