/**
 * Una función plegada en su tarjeta «Qué hace» se acaba de abrir: de dónde sale el diagrama que aparece. Con
 * esto el marco de la función crece desde la tarjeta y lo de dentro se despliega de arriba abajo, en vez de
 * aparecer todo de golpe: se ve que el diagrama es la misma cosa, contada con más detalle.
 *
 * Dura lo que la transición; después no queda nada (lo que nazca más tarde nace como siempre).
 */
export interface Opening {
  /** La función que se abre. */
  id: string
  /** Lo que medía su tarjeta. */
  w: number
  h: number
  /** Dónde estaba (su borde de arriba, en el lienzo). */
  y: number
}

/** Lo que tarda en desplegarse todo: quien nazca en este rato viene de esa tarjeta. */
export const OPENING_MS = 700

let opening: Opening | null = null
let timer: ReturnType<typeof setTimeout> | undefined

export function markOpening(next: Opening) {
  opening = next
  clearTimeout(timer)
  timer = setTimeout(() => {
    opening = null
  }, OPENING_MS)
}

export const openingNow = (): Opening | null => opening

/**
 * Lo que espera a aparecer un nodo que nace mientras se abre una función: más cuanto más abajo está, así el
 * diagrama se desenrolla desde la tarjeta. `null` si no nace de ninguna.
 */
export function unrollDelay(id: string, y: number): number | null {
  if (!opening || opening.id === id) return null
  return Math.round(Math.min(460, Math.max(0, (y - opening.y) * 0.45)))
}
