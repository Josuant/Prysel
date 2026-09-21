import { VALUE_NAMES, accepts, isTerritoryKind, type NodeAction } from '@prysel/morphology'
import type { CanvasNode } from './Canvas.tsx'

/**
 * ¿Se puede conectar esta salida a este campo? La respuesta la da el propio diagrama, antes de
 * escribir nada: un cable que escribiera un nombre que Python no conoce en ese punto, o un valor
 * que no vale en ese campo, rompería el programa.
 */

/** Los dos extremos de un cable: de qué puerto sale y a qué campo llega. */
export interface Link {
  from: string
  /** Un parámetro de función (`param:a`) o un resultado entre varios (`result:a`) salen por su propio puerto; el resto, por el normal. */
  port?: string
  to: string
  slot: string
  /** Se convierte al conectar: ver `Verdict`. */
  convert?: 'float'
}

/**
 * El veredicto de una conexión. Un texto que llega a un campo que pide un número no se rechaza:
 * se convierte (`convert`), y el nodo escribe `float(nombre)`. Lo demás que no encaja, sí se rechaza.
 */
export type Verdict = { ok: true; name: string; convert?: 'float' } | { ok: false; reason: string }

/** El nombre que sale por un puerto de un nodo, si sale alguno. */
export function outputName(node: CanvasNode, port?: string): string | undefined {
  if (port?.startsWith('param:')) {
    const name = port.slice('param:'.length)
    return node.params?.includes(name) ? name : undefined
  }
  if (port?.startsWith('result:')) {
    const name = port.slice('result:'.length)
    return node.results?.includes(name) ? name : undefined
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
    // Un texto donde se pide un número (lo que devuelve `input()`): se convierte en vez de rechazarlo.
    if (given === 'text' && accepts(target.control, link.slot, 'number')) {
      return { ok: true, name, convert: 'float' }
    }
    return { ok: false, reason: `No se puede conectar ${VALUE_NAMES[given]} a ese campo.` }
  }
  return { ok: true, name }
}

/** Lo que se le dice a quien conecta cuando el valor se convirtió por el camino. */
export const convertNotice = (name: string) =>
  `«${name}» es un texto y ese campo pide un número: se escribió float(${name}).`

/** El gesto de conectar, como la acción que lo escribe en el código. */
export const connectAction = (link: Link): NodeAction => ({
  type: 'connect',
  from: link.from,
  to: link.to,
  slot: link.slot,
  ...(link.port === undefined ? {} : { port: link.port }),
  ...(link.convert === undefined ? {} : { convert: link.convert }),
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
  const inside = port?.startsWith('param:') || isTerritoryKind(source.kind)
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
    const territory = anchor.kind === 'abstraction.collapsed' || isTerritoryKind(anchor.kind)
    return territory
      ? { where: `Dentro de «${anchor.label}»`, place: { into: anchor.id } }
      : { where: `Después de «${anchor.label}»`, place: { after: anchor.id } }
  }
  return focus
    ? { where: `Al final de ${focus.name}`, place: { into: focus.id } }
    : { where: 'Al final del programa', place: {} }
}

/**
 * El gesto de **orden**: un cable de orden va de lo que se ejecuta antes a lo que se ejecuta después, y
 * al soltarlo sobre un nodo, ese nodo pasa a ejecutarse ahí. Arrastrar el cable **es** mover la
 * sentencia en el código. Los puertos de salida dicen dónde queda:
 * - `order-out`: justo detrás del nodo.
 * - `order-yes` / `order-no`: al principio del camino verdadero / del `else` de una decisión.
 * - `order-body`: al principio de lo que actúa en una función o un bucle.
 */
export const ORDER_IN = 'order-in'
export type OrderPort = 'order-out' | 'order-yes' | 'order-no' | 'order-body'
const ORDER_PORTS: readonly string[] = ['order-out', 'order-yes', 'order-no', 'order-body']

/** ¿Es el puerto de orden de un nodo (de salida o de entrada)? */
export const isOrderHandle = (handle: string | null | undefined): boolean =>
  handle === ORDER_IN || (handle != null && ORDER_PORTS.includes(handle))

/** Las sentencias tras las que la ejecución no sigue: detrás de ellas nada se ejecutaría. */
const JUMPS: ReadonlySet<string> = new Set([
  'control.return',
  'control.raise',
  'control.break',
  'control.continue',
])

const CLAUSES: ReadonlySet<string> = new Set(['control.except', 'control.clause'])

/** ¿Está `child` dentro de `ancestor`, a cualquier profundidad? Moverlo ahí cerraría un ciclo. */
function within(nodes: ReadonlyMap<string, CanvasNode>, child: string, ancestor: string): boolean {
  const seen = new Set<string>()
  for (let id: string | undefined = child; id !== undefined && !seen.has(id);) {
    seen.add(id)
    if (id === ancestor) return true
    const node = nodes.get(id)
    if (node?.owner !== undefined) id = node.owner
    else id = [...nodes.values()].find((other) => other.contains?.includes(id as string))?.id
  }
  return false
}

/** Dónde se crea un nodo nuevo desde un puerto de orden (los mismos sitios en que se coloca uno existente). */
export function orderPlace(
  from: string,
  port: OrderPort,
): { after: string } | { into: string; branch: 'yes' | 'no' } | { into: string; start: true } {
  switch (port) {
    case 'order-out':
      return { after: from }
    case 'order-yes':
      return { into: from, branch: 'yes' }
    case 'order-no':
      return { into: from, branch: 'no' }
    case 'order-body':
      return { into: from, start: true }
  }
}

export type OrderVerdict = { ok: true; action: NodeAction } | { ok: false; reason: string }

/** ¿Se puede soltar el cable de orden de `from` (por su puerto) sobre `to`? Y, si sí, la acción que lo escribe. */
export function checkOrder(
  nodes: ReadonlyMap<string, CanvasNode>,
  link: { from: string; port: OrderPort; to: string },
): OrderVerdict {
  const source = nodes.get(link.from)
  const target = nodes.get(link.to)
  if (!source || !target) return { ok: false, reason: 'Ese nodo ya no está.' }
  if (source.id === target.id)
    return { ok: false, reason: 'Un nodo no se ordena respecto a sí mismo.' }
  if (within(nodes, source.id, target.id)) {
    return { ok: false, reason: 'No se puede meter algo dentro de sí mismo.' }
  }
  // Una cláusula (si falla, si no falla, al final) vive dentro de su try: no se mueve ni se pone algo tras ella.
  if (CLAUSES.has(target.kind)) {
    return { ok: false, reason: 'Una cláusula de un try no se mueve por sí sola.' }
  }
  if (link.port === 'order-out' && CLAUSES.has(source.kind)) {
    return {
      ok: false,
      reason: 'Detrás de una cláusula no se puede poner nada: va dentro de ella.',
    }
  }
  switch (link.port) {
    case 'order-out':
      if (JUMPS.has(source.kind)) {
        return {
          ok: false,
          reason: 'Después de un return, raise, break o continue no se ejecuta nada.',
        }
      }
      return { ok: true, action: { type: 'move', id: target.id, after: source.id } }
    case 'order-yes':
    case 'order-no':
      if (source.kind !== 'control.condition') {
        return { ok: false, reason: 'Solo una decisión tiene camino verdadero y falso.' }
      }
      return {
        ok: true,
        action: {
          type: 'move',
          id: target.id,
          into: source.id,
          branch: link.port === 'order-yes' ? 'yes' : 'no',
        },
      }
    case 'order-body':
      if (source.kind !== 'abstraction.collapsed' && !isTerritoryKind(source.kind)) {
        return { ok: false, reason: 'Solo una función o un bucle tienen cuerpo.' }
      }
      return { ok: true, action: { type: 'move', id: target.id, into: source.id, start: true } }
  }
}
