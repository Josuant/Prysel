/**
 * Las vueltas de un bucle dentro de su propio territorio: lo que valió, vuelta a vuelta, cada nombre que
 * cambia, con un deslizador para elegir la vuelta que se mira y una curva pequeña por cada número.
 * Es lo que hace de un bucle de entrenamiento algo que se puede recorrer sin abrir ningún panel. Solo
 * lee lo que se anotó al ejecutar: no cambia el programa.
 */

export interface LapsView {
  /** Cuántas vueltas dio (o lleva, si sigue corriendo). */
  n: number
  /** El bucle acabó: si no, sigue corriendo y la última vuelta cambia. */
  done: boolean
  /** Qué vueltas (base 0) tienen valor: todas al principio y, en un bucle largo, una muestra. */
  idx: readonly number[]
  names: Readonly<Record<string, readonly (number | string | null)[]>>
  /** La posición (dentro de `idx`) de la vuelta que se mira. */
  position: number
  onPosition?: (position: number) => void
}

/** Lo que la franja de vueltas suma a la cabecera de un bucle que ya las dio. */
export const LAPS_HEADROOM = 44

/** Cuántas curvas caben a la vez en la franja. */
export const MAX_CURVES = 3

/** Los nombres que suelen ser lo que se vigila en un entrenamiento: van primero. */
const WATCHED = /loss|perd|error|err|acc|prec|score|reward|metric/i

/** ¿Es un contador (`0, 1, 2, …`, igual a la vuelta)? No dice nada que la vuelta no diga. */
const isCounter = (values: readonly (number | string | null)[], idx: readonly number[]) =>
  values.every((value, i) => value === (idx[i] ?? i))

/**
 * Qué curvas dibujar: los nombres con al menos dos números que no son un contador ni una variable del
 * bucle (`exclude`), los que suelen vigilarse (pérdida, precisión…) primero, y como mucho `MAX_CURVES`.
 */
export function pickCurves(
  names: LapsView['names'],
  idx: readonly number[],
  exclude: readonly string[] = [],
  max = MAX_CURVES,
): string[] {
  const found = Object.entries(names).filter(
    ([name, values]) =>
      !exclude.includes(name) &&
      values.filter((value) => typeof value === 'number').length >= 2 &&
      !isCounter(values, idx),
  )
  const first = found.filter(([name]) => WATCHED.test(name))
  const rest = found.filter(([name]) => !WATCHED.test(name))
  return [...first, ...rest].slice(0, max).map(([name]) => name)
}

/** Una curva en un rectángulo: su trazado y dónde cae el punto de cada vuelta. */
export interface Spark {
  path: string
  /** El punto de la posición pedida, si esa vuelta tiene un número. */
  dot: (position: number) => { x: number; y: number } | null
}

/** Dibuja `values` (una por vuelta de `idx`, sobre `n` vueltas) en un rectángulo de `w` × `h`. */
export function spark(
  values: readonly (number | string | null)[],
  idx: readonly number[],
  n: number,
  w: number,
  h: number,
  pad = 2,
): Spark {
  const points = values.flatMap((value, position) =>
    typeof value === 'number' && Number.isFinite(value)
      ? [{ position, at: idx[position] ?? position, value }]
      : [],
  )
  const nums = points.map((point) => point.value)
  const min = Math.min(...nums)
  const span = Math.max(...nums) - min || 1
  const last = Math.max(1, n - 1)
  const place = (at: number, value: number) => ({
    x: pad + (at / last) * (w - 2 * pad),
    y: h - pad - ((value - min) / span) * (h - 2 * pad),
  })
  return {
    path: points
      .map((point, i) => {
        const { x, y } = place(point.at, point.value)
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(' '),
    dot: (position) => {
      const point = points.find((candidate) => candidate.position === position)
      return point ? place(point.at, point.value) : null
    },
  }
}

/** Un valor de una vuelta, corto: un número con pocas cifras, o su descripción recortada. */
export function formatLap(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value)
    const abs = Math.abs(value)
    return abs !== 0 && (abs < 0.001 || abs >= 1e6)
      ? value.toExponential(2)
      : String(Number(value.toPrecision(4)))
  }
  return value.length > 14 ? `${value.slice(0, 13)}…` : value
}
