import { EdgeLabelRenderer, type EdgeProps, type Edge as FlowEdge } from '@xyflow/react'

/**
 * Una flecha de la **arquitectura**: lo que une dos módulos. No sale de un puerto ni sigue la secuencia: va de
 * borde a borde, por el camino más corto, porque dice una relación, no un orden.
 *
 * Hay dos, y se distinguen de un vistazo:
 * - **dato** (continua, con su pastilla): lo que un módulo deja y el otro usa. La pastilla dice qué.
 * - **llamada** (fina, a trazos): un módulo usa algo que el otro define.
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
  kind: 'data' | 'call'
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

/** El trazado: una curva suave de borde a borde, su punto medio (para la pastilla) y cómo llega (la punta). */
export function archPath(from: Box, to: Box, bend = 0) {
  const curve = curveOf(from, to, bend)
  const { start, control, end } = curve
  const angle = (Math.atan2(end.y - control.y, end.x - control.x) * 180) / Math.PI
  return {
    d: `M${start.x.toFixed(1)} ${start.y.toFixed(1)}Q${control.x.toFixed(1)} ${control.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
    mid: along(curve, 0.5),
    end,
    angle,
  }
}

/** ¿Pasa la flecha por encima de alguna de esas cajas? */
export function crosses(from: Box, to: Box, bend: number, others: readonly Box[]): boolean {
  const curve = curveOf(from, to, bend)
  const air = 10
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
const BENDS = [30, 56, 88, 124, 168, 220]

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
  const { d, mid, end, angle } = archPath(data.from, data.to, data.bend)
  const style = { '--i': data.turn ?? 0 } as React.CSSProperties
  return (
    <>
      <g
        className="arch-edge"
        data-kind={data.kind}
        data-planned={data.planned ? '' : undefined}
        data-emphasis={data.emphasis}
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
      </g>
      {label && (
        <EdgeLabelRenderer>
          <span
            className="arch-edge__label"
            data-kind={data.kind}
            data-planned={data.planned ? '' : undefined}
            data-emphasis={data.emphasis}
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
