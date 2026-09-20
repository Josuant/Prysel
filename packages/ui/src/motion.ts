import { useEffect, useRef, useState } from 'react'

/**
 * Movimiento: la quinta dimensión de la gramática espacial.
 *
 * Cuando el programa cambia, el diagrama no salta — se mueve. Y el movimiento dice qué pasó:
 * un nodo que **se desplaza** conserva su identidad (es el mismo, en otro sitio),
 * uno que **entra** aparece (algo nuevo se escribió),
 * uno que **sale** se desvanece (algo se borró o se colapsó).
 *
 * Es lo que permite seguir con la vista un nodo concreto mientras se teclea, en vez de
 * tener que volver a buscarlo en cada pulsación.
 */

export interface Positioned {
  x: number
  y: number
}

/** Cómo llegó cada nodo a su posición actual. */
export type MotionPhase = 'settled' | 'entering' | 'moving' | 'leaving'

export interface MotionItem<T> {
  id: string
  value: T
  position: Positioned
}

export interface Animated<T> extends MotionItem<T> {
  phase: MotionPhase
}

export interface MotionOptions {
  /** Duración del desplazamiento. */
  duration?: number
  /** Cuánto se queda un nodo que ya no existe, mientras se desvanece. */
  exitDuration?: number
  /** Desactiva la animación (zoom lejano, lienzos enormes, o preferencia del usuario). */
  disabled?: boolean
}

const DEFAULTS = { duration: 340, exitDuration: 180 }

/** Salida suave: arranca rápido y frena al llegar. */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

/** Una posición es la misma si coincide al píxel: por debajo de eso no hay nada que animar. */
const same = (a: Positioned, b: Positioned) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1

function settle<T>(items: MotionItem<T>[]): Animated<T>[] {
  return items.map((item) => ({ ...item, phase: 'settled' as const }))
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Interpola las posiciones hacia su destino y retiene un instante a los que desaparecen.
 * `items` es la verdad: lo que el layout acaba de calcular.
 */
export function useMotion<T>(items: MotionItem<T>[], options: MotionOptions = {}): Animated<T>[] {
  const { duration, exitDuration, disabled } = { ...DEFAULTS, ...options }
  const still = disabled === true || prefersReducedMotion()

  const [shown, setShown] = useState<Animated<T>[]>(() => settle(items))
  /** Lo último que se dibujó. Solo se escribe dentro del bucle, nunca en fase de render. */
  const drawn = useRef<Animated<T>[]>([])

  /** Una transición nueva empieza cuando cambia el conjunto de nodos o alguna posición. */
  const signature = items
    .map((item) => `${item.id}@${item.position.x},${item.position.y}`)
    .join('|')

  useEffect(() => {
    const commit = (next: Animated<T>[]) => {
      drawn.current = next
      setShown(next)
    }

    if (still) {
      commit(settle(items))
      return
    }

    const previous = new Map(drawn.current.map((a) => [a.id, a]))
    const wanted = new Set(items.map((item) => item.id))
    // Cada nodo sale de donde estaba; uno nuevo nace en su sitio, no se arrastra de ninguna parte.
    const from = new Map(
      items.map((item) => [item.id, previous.get(item.id)?.position ?? item.position]),
    )
    const fresh = new Set(items.filter((item) => !previous.has(item.id)).map((item) => item.id))
    const leaving = [...previous.values()].filter((a) => !wanted.has(a.id) && a.phase !== 'leaving')

    const start = performance.now()
    let frame = 0
    const step = () => {
      const elapsed = performance.now() - start
      const t = duration === 0 ? 1 : easeOut(Math.min(1, elapsed / duration))

      const next: Animated<T>[] = items.map((item) => {
        const origin = from.get(item.id) ?? item.position
        const arrived = t >= 1 || same(origin, item.position)
        return {
          id: item.id,
          value: item.value,
          position: arrived
            ? item.position
            : {
                x: origin.x + (item.position.x - origin.x) * t,
                y: origin.y + (item.position.y - origin.y) * t,
              },
          phase: arrived ? 'settled' : fresh.has(item.id) ? 'entering' : 'moving',
        }
      })
      // Los que se van siguen dibujándose hasta que termina su desvanecido.
      if (elapsed < exitDuration) {
        for (const gone of leaving) next.push({ ...gone, phase: 'leaving' })
      }

      commit(next)
      if (elapsed < Math.max(duration, exitDuration)) frame = requestAnimationFrame(step)
    }
    step()

    return () => {
      cancelAnimationFrame(frame)
    }
  }, [signature, still, duration, exitDuration, items])

  return shown
}
