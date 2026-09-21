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

export function nodeFrame(size: { w: number; h: number }): NodeFrame {
  return {
    width: size.w,
    height: size.h,
    initialWidth: size.w,
    initialHeight: size.h,
    measured: { width: size.w, height: size.h },
  }
}
