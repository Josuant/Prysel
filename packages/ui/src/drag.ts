/**
 * Arrastrar un territorio arrastra lo que envuelve: todo se desplaza lo mismo que él.
 * Es una función pura sobre posiciones para poder comprobarla sin un navegador.
 */

export interface Point {
  x: number
  y: number
}

/**
 * @param moved   posiciones que el usuario ya ha fijado a mano
 * @param shown   dónde está cada nodo ahora mismo (lo que propone la gramática, o donde va la animación)
 * @param id      el nodo que se arrastra
 * @param to      dónde ha quedado
 * @param inside  todo lo que ese nodo envuelve (vacío si no es un territorio)
 */
export function dragTerritory(
  moved: Record<string, Point>,
  shown: Record<string, Point>,
  id: string,
  to: Point,
  inside: readonly string[],
): Record<string, Point> {
  const next: Record<string, Point> = { ...moved, [id]: to }
  const from = moved[id] ?? shown[id]
  if (!from) return next
  const dx = to.x - from.x
  const dy = to.y - from.y
  for (const child of inside) {
    const at = moved[child] ?? shown[child]
    if (at) next[child] = { x: at.x + dx, y: at.y + dy }
  }
  return next
}
