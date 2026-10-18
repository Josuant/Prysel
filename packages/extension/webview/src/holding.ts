import type { ArchShape } from '@prysel/spatial'

/**
 * La **forma** de la arquitectura mientras se construye: se decide **una sola vez**.
 *
 * Según llega el plan y luego el código, el grafo de módulos va cambiando, y con él las formas que cuadran: sin
 * más, el diagrama pasaba de embudo a ciclo, a centro y otra vez a ciclo en medio minuto. Aquí se decide cuándo
 * se elige y que, una vez elegida, no se toque hasta acabar:
 *
 * - **Mientras llega el plan**, nada de formas: los módulos van en filas (`capas`), que es lo que no promete
 *   nada.
 * - **Con el plan entero** (y lo que diga de él el JEV, o un rato de espera si no contesta), se elige. Esa es
 *   la forma para toda la construcción, mientras su módulo de referencia siga existiendo.
 * - **Sin plan** (una pieza suelta, o al tocar un programa que ya existe), como siempre: la forma que haya,
 *   y si se cae a `capas` en un mal momento, la última que hubo.
 *
 * Al acabar de construir manda lo que el programa sea de verdad (y, si se ejecuta, lo que pasó).
 */
export interface Held {
  shape: ArchShape
  /** El módulo de referencia de la forma, por su título (cambia de línea mientras se escribe). */
  anchor: string | null
  /** Ya está decidida: no se vuelve a elegir en lo que queda de construcción. */
  final: boolean
}

export function holdShape(now: {
  /** Se está construyendo algo. */
  constructing: boolean
  /** …con un plan (varias partes anunciadas antes de escribirlas). */
  planning: boolean
  /** El plan ya está entero y se puede elegir (el JEV ya dijo, o se acabó de esperarle). */
  decidable: boolean
  /** Lo que se venía manteniendo. */
  held: Held | null
  /** La forma que el grafo de ahora (con lo que dijo el JEV) tendría por sí solo. */
  judged: { shape: ArchShape; anchor: string | null } | null
  /** ¿Sigue habiendo un módulo con ese título? */
  alive: (title: string) => boolean
}): Held | null {
  const { held, judged } = now
  if (!now.constructing || !judged) return null
  if (!now.planning) {
    return judged.shape !== 'capas'
      ? { shape: judged.shape, anchor: judged.anchor, final: false }
      : held && !held.final
        ? held
        : null
  }
  // Decidida, y su módulo de referencia sigue ahí: no se toca.
  if (held?.final && (held.anchor === null || now.alive(held.anchor))) return held
  if (!now.decidable) return { shape: 'capas', anchor: null, final: false }
  return { shape: judged.shape, anchor: judged.anchor, final: true }
}

/** ¿Es la misma? (Para no volver a guardar lo que ya está guardado.) */
export const sameHeld = (a: Held | null, b: Held | null): boolean =>
  a === b ||
  (a !== null && b !== null && a.shape === b.shape && a.anchor === b.anchor && a.final === b.final)
