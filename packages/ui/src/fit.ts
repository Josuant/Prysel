import { DEFAULT_MAX_RUN } from '@prysel/spatial'

/**
 * Cuánto mide de largo una fila del diagrama según el ancho que hay para verlo.
 *
 * El diagrama se lee al ancho y se recorre hacia abajo, como un documento: el encuadre ajusta el ancho del
 * programa al del lienzo. Con una fila de pantalla grande (`DEFAULT_MAX_RUN`), en un panel estrecho
 * (unos 370 px junto al editor) eso lo alejaba hasta dejar los nodos ilegibles. Aquí se pliega antes:
 * la fila mide lo que cabe a un zoom legible, y el programa gana en alto lo que pierde en ancho.
 */

/** El zoom al que un nodo todavía se lee: la fila se pliega para no bajar de él, si se puede. */
export const LEGIBLE_ZOOM = 0.75

/**
 * Lo mínimo que puede medir una fila: cabe una tarjeta de una línea de las más anchas con su margen. Por
 * debajo, un nodo se cortaría; en un panel más estrecho, el diagrama se recorre también en horizontal.
 */
export const MIN_RUN = 720

/** Las medidas se redondean a saltos de esto: redimensionar el panel no rehace el diagrama a cada píxel. */
export const RUN_STEP = 80

/**
 * El largo de fila para un lienzo de `width` píxeles de ancho, o `undefined` si el de siempre ya cabe
 * (una pantalla grande) o todavía no se ha medido.
 */
export function runFor(width: number): number | undefined {
  if (!Number.isFinite(width) || width <= 0) return undefined
  const wanted = Math.ceil(width / LEGIBLE_ZOOM / RUN_STEP) * RUN_STEP
  return wanted >= DEFAULT_MAX_RUN ? undefined : Math.max(MIN_RUN, wanted)
}

/**
 * El sitio que queda para el diagrama cuando algo ocupa el rincón de abajo a la derecha del lienzo (la
 * consola): o todo el alto a su izquierda, o todo el ancho por encima. Se queda con el que deja ver el
 * diagrama más grande. Sin nada en el rincón (o si lo ocupa casi todo), el lienzo entero.
 */
export function roomFor(
  frame: { w: number; h: number },
  bounds: { w: number; h: number },
  corner: { w: number; h: number } | null | undefined,
  pad = 24,
): { w: number; h: number } {
  if (!corner || corner.w <= 0 || corner.h <= 0) return frame
  const beside = { w: frame.w - corner.w, h: frame.h }
  const above = { w: frame.w, h: frame.h - corner.h }
  const zoomIn = (room: { w: number; h: number }) =>
    Math.min((room.w - pad * 2) / bounds.w, (room.h - pad * 2) / bounds.h)
  const rooms = [beside, above].filter((room) => room.w > 240 && room.h > 180)
  if (rooms.length === 0) return frame
  return rooms.reduce((best, room) => (zoomIn(room) > zoomIn(best) ? room : best))
}

/** El zoom al que la arquitectura todavía se lee: son tarjetas con título, aguantan algo más lejos. */
export const ARCH_ZOOM = 0.62
/** Lo que se reserva a un lado para lo que no es el diagrama (la cajita de funciones y variables). */
const ARCH_SIDE = 280

/**
 * Lo más ancho que puede ser una fila de módulos de la arquitectura en un lienzo de `width` píxeles: lo que
 * cabe a un zoom legible. `undefined` si aún no se ha medido.
 */
export function archRunFor(width: number): number | undefined {
  if (!Number.isFinite(width) || width <= 0) return undefined
  const wanted = Math.floor(width / ARCH_ZOOM / RUN_STEP) * RUN_STEP - ARCH_SIDE
  return Math.max(560, wanted)
}
