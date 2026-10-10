import { EdgeLabelRenderer, type EdgeProps, type Edge as FlowEdge } from '@xyflow/react'

/**
 * Una flecha de la **arquitectura**: lo que une dos módulos. No sale de un puerto ni sigue la secuencia: va de
 * borde a borde, por el camino más corto, porque dice una relación, no un orden.
 *
 * Hay dos, y se distinguen de un vistazo:
 * - **dato** (continua, con su pastilla): lo que un módulo deja y el otro usa. La pastilla dice qué.
 * - **llamada** (fina, a trazos): un módulo usa algo que el otro define.
 * - **luego** (fina, continua, sin pastilla): después de un paso viene el otro, sin pasarle nada.
 *
 * `planned`: aún no está en el código; la propuso el plan. Se dibuja punteada y tenue hasta que el código la
 * confirme (o la desmienta, y entonces desaparece).
 */

interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface ArchEdgeData extends Record<string, unknown> {
  kind: 'data' | 'call' | 'next'
  /** Dónde están ahora los dos módulos: la flecha va de borde a borde. */
  from: Box
  to: Box
  planned?: boolean
  /** Cuánto se comba (en px, hacia un lado): dos flechas entre los mismos módulos no se pisan. */
  bend?: number
  /** Con algo seleccionado: las suyas destacan y las demás se retiran. */
  emphasis?: 'active' | 'dim'
  /** El turno en que se traza al aparecer, para que entren una detrás de otra. */
  turn?: number
  /**
   * Al reproducir: por esta flecha pasa algo ahora. El número cambia en cada paso (la ficha vuelve a salir) y
   * `ms` es lo que tarda en llegar.
   */
  live?: number
  ms?: number
  /** En qué punto de la curva (de 0 a 1) va la pastilla: la mitad, salvo que ahí pise a alguien. */
  labelAt?: number
}

export type ArchFlowEdge = FlowEdge<ArchEdgeData, 'arch'>

interface Point {
  x: number
  y: number
}

const centre = (box: Box): Point => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })

/** Dónde corta el borde de una caja la recta que va de su centro hacia `toward`, con un poco de aire. */
function edgeOf(box: Box, toward: Point, air: number): Point {
  const from = centre(box)
  const dx = toward.x - from.x
  const dy = toward.y - from.y
  if (dx === 0 && dy === 0) return from
  const scale = Math.min(
    dx === 0 ? Infinity : (box.w / 2 + air) / Math.abs(dx),
    dy === 0 ? Infinity : (box.h / 2 + air) / Math.abs(dy),
  )
  return { x: from.x + dx * scale, y: from.y + dy * scale }
}

/** La curva de una flecha: de dónde sale, hacia dónde se comba y adónde llega. */
function curveOf(from: Box, to: Box, bend: number) {
  const a = centre(from)
  const b = centre(to)
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
  // El punto de control, apartado a un lado: la curva se comba hacia él.
  const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length }
  const control = {
    x: (a.x + b.x) / 2 + normal.x * bend * 2,
    y: (a.y + b.y) / 2 + normal.y * bend * 2,
  }
  return { start: edgeOf(from, control, 4), control, end: edgeOf(to, control, 9) }
}

/** Un punto de la curva (`t` de 0 a 1). */
const along = ({ start, control, end }: ReturnType<typeof curveOf>, t: number): Point => ({
  x: (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * control.x + t * t * end.x,
  y: (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * control.y + t * t * end.y,
})

/**
 * El trazado: una curva suave de borde a borde, el punto donde va su pastilla (`labelAt`: la mitad, si no se
 * dice otro) y cómo llega (la punta).
 */
export function archPath(from: Box, to: Box, bend = 0, labelAt = 0.5) {
  const curve = curveOf(from, to, bend)
  const { start, control, end } = curve
  const angle = (Math.atan2(end.y - control.y, end.x - control.x) * 180) / Math.PI
  return {
    d: `M${start.x.toFixed(1)} ${start.y.toFixed(1)}Q${control.x.toFixed(1)} ${control.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
    mid: along(curve, labelAt),
    end,
    angle,
  }
}

/** Lo que mide la pastilla de una flecha con ese texto (letra de ancho fijo, con su relleno y su tope). */
export const labelSize = (text: string) => ({ w: Math.min(180, text.length * 6.7 + 18), h: 19 })

/** Los puntos de la curva que se prueban para la pastilla: la mitad primero, y de ahí hacia los extremos. */
const LABEL_SPOTS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]

/**
 * En qué punto de su flecha va una pastilla para no tapar a nadie: en la mitad si cabe; si no, el punto de la
 * curva donde menos pise (un módulo, una marca u otra pastilla). Con los módulos muy juntos una flecha es
 * corta y su pastilla, más ancha que ella: se corre hacia donde hay hueco.
 */
export function labelSpot(
  from: Box,
  to: Box,
  bend: number,
  size: { w: number; h: number },
  obstacles: readonly Box[],
): number {
  const curve = curveOf(from, to, bend)
  const air = 3
  const covered = (t: number) => {
    const at = along(curve, t)
    const left = at.x - size.w / 2 - air
    const top = at.y - size.h / 2 - air
    let area = 0
    for (const box of obstacles) {
      const w = Math.min(left + size.w + air * 2, box.x + box.w) - Math.max(left, box.x)
      const h = Math.min(top + size.h + air * 2, box.y + box.h) - Math.max(top, box.y)
      if (w > 0 && h > 0) area += w * h
    }
    return area
  }
  let best = { t: 0.5, area: Infinity }
  for (const t of LABEL_SPOTS) {
    const area = covered(t)
    if (area === 0) return t
    if (area < best.area) best = { t, area }
  }
  return best.t
}

/** ¿Pasa la flecha por encima de alguna de esas cajas? */
export function crosses(from: Box, to: Box, bend: number, others: readonly Box[]): boolean {
  const curve = curveOf(from, to, bend)
  const air = 6
  for (let step = 1; step < 16; step++) {
    const at = along(curve, step / 16)
    const hit = others.some(
      (box) =>
        at.x > box.x - air &&
        at.x < box.x + box.w + air &&
        at.y > box.y - air &&
        at.y < box.y + box.h + air,
    )
    if (hit) return true
  }
  return false
}

/** Lo que se prueba a combar una flecha, de menos a más y a los dos lados, hasta que no pise a nadie. */
const BENDS = [30, 56, 88, 124, 168, 220, 280, 350]

/**
 * Cuánto se comba una flecha para no pasar por encima de ningún otro módulo: lo que se prefiera (`0`, recta),
 * si pasa limpia; si no, lo mínimo que la libre, hacia el lado que antes lo consiga. Si nada la libra, se
 * queda como se prefería: una flecha que cruza dice más que una que no está.
 */
export function clearBend(from: Box, to: Box, others: readonly Box[], prefer = 0): number {
  const tries = [prefer, ...BENDS.flatMap((bend) => (prefer < 0 ? [-bend, bend] : [bend, -bend]))]
  return tries.find((bend) => !crosses(from, to, bend, others)) ?? prefer
}

export function ArchEdge({ data, label }: EdgeProps<ArchFlowEdge>) {
  if (!data) return null
  const { d, mid, end, angle } = archPath(data.from, data.to, data.bend, data.labelAt)
  const style = { '--i': data.turn ?? 0 } as React.CSSProperties
  return (
    <>
      <g
        className="arch-edge"
        data-kind={data.kind}
        data-planned={data.planned ? '' : undefined}
        data-emphasis={data.emphasis}
        data-live={data.live === undefined ? undefined : ''}
        style={style}
      >
        <path className="arch-edge__line" d={d} pathLength={1} />
        {/* Lo que viaja: un pulso que recorre la flecha en el sentido en que pasa el dato. */}
        {data.kind === 'data' && !data.planned && (
          <path className="arch-edge__pulse" d={d} pathLength={1} />
        )}
        <path
          className="arch-edge__head"
          d="M-8 -4.5L0 0L-8 4.5z"
          transform={`translate(${end.x.toFixed(1)} ${end.y.toFixed(1)}) rotate(${angle.toFixed(1)})`}
        />
        {/* Al reproducir: la ficha de lo que pasa, de un módulo al otro, una vez por paso. */}
        {data.live !== undefined && (
          <circle
            key={data.live}
            className="arch-edge__token"
            r={6}
            style={{ offsetPath: `path("${d}")`, animationDuration: `${data.ms ?? 900}ms` }}
          />
        )}
      </g>
      {label && (
        <EdgeLabelRenderer>
          <span
            className="arch-edge__label"
            data-kind={data.kind}
            data-planned={data.planned ? '' : undefined}
            data-emphasis={data.emphasis}
            data-live={data.live === undefined ? undefined : ''}
            style={{
              ...style,
              transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`,
            }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
