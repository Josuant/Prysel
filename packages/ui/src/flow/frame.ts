import {
  HEADER_EDITOR_KINDS,
  LOOP_HEADROOM,
  docHeadroom,
  isTerritoryKind,
} from '@prysel/morphology'

/**
 * Las dimensiones de un nodo dentro de React Flow.
 *
 * El tamaño de un nodo lo decide la gramática, no el DOM: aquí se entrega **ya medido**. Es lo
 * que evita un fallo sutil: los nodos se reconstruyen derivados del layout en cada render (en
 * cada arrastre, en cada fotograma del movimiento), y cuando React Flow recibe un nodo nuevo
 * sin `measured` lo da por «reinicializado» y **descarta sus puertos** para medirlo otra vez.
 * Esa medición solo se relanza si el tamaño cambia, así que el nodo se quedaba sin puertos y
 * sus conexiones desaparecían al moverlo.
 */
export interface NodeFrame {
  width: number
  height: number
  initialWidth: number
  initialHeight: number
  measured: { width: number; height: number }
}

/** ¿Es un bucle con cuerpo? Se dibuja como territorio: envuelve lo que repite, como una función. */
export const isLoopTerritory = (node: { kind: string; contains?: readonly string[] | undefined }) =>
  node.kind === 'control.loop' && (node.contains?.length ?? 0) > 0

/**
 * ¿Es un bucle, un `with`, un `try` o una de sus cláusulas con algo dentro? Se dibuja como territorio,
 * como una función: envuelve físicamente lo que abarca.
 */
export const isTerritory = (node: { kind: string; contains?: readonly string[] | undefined }) =>
  isTerritoryKind(node.kind) && (node.contains?.length ?? 0) > 0

/**
 * Lo que la cabecera de un territorio pide sobre el margen de serie: la documentación de una función
 * o de un bucle, y el editor del bucle (`para x en …`), que vive en su cabecera.
 */
export function territoryHeadroom(node: {
  kind: string
  note?: string | undefined
  control?: unknown
  contains?: readonly string[] | undefined
}): number {
  if ((node.contains?.length ?? 0) === 0) return 0
  return (
    (node.note ? docHeadroom(node.note) : 0) +
    (isTerritory(node) && HEADER_EDITOR_KINDS.has(node.kind) && node.control ? LOOP_HEADROOM : 0)
  )
}

export function nodeFrame(size: { w: number; h: number }): NodeFrame {
  return {
    width: size.w,
    height: size.h,
    initialWidth: size.w,
    initialHeight: size.h,
    measured: { width: size.w, height: size.h },
  }
}
