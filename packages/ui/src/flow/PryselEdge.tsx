import { useMemo } from 'react'
import { EdgeLabelRenderer, type EdgeProps, type Edge as FlowEdge } from '@xyflow/react'
import {
  routeEdge,
  routeOrthogonal,
  type Axis,
  type Channel,
  type Rect,
  type Relation,
} from '@prysel/spatial'

/**
 * Una conexión dentro de React Flow, trazada por la gramática de conexiones.
 * React Flow aporta los extremos (ya sabe dónde está cada puerto); el trazado sale de la
 * gramática: una conexión de flujo va en ángulos de 90° esquivando todo lo que se interpone
 * (`routeOrthogonal`), y las que van contra el flujo —el retorno de un bucle, el salto de fila—
 * conservan su trazado propio (`routeEdge`), porque es ahí donde vive su significado.
 */

/** Un obstáculo para el enrutado: un nodo, o el territorio de una función. */
export interface EdgeObstacle extends Rect {
  id: string
}

export interface PryselEdgeData extends Record<string, unknown> {
  relation: Relation
  /** Control (orden de ejecución) o datos (paso de valores): dos lenguajes visuales distintos. */
  channel: Channel
  axis: Axis
  /** Todo lo que hay en el lienzo, con su posición de ahora mismo. */
  obstacles?: EdgeObstacle[]
  /** Quién contiene a quién: un territorio no es obstáculo para lo que sale de dentro. */
  parentOf?: Record<string, string>
  /** Con algo seleccionado: sus conexiones destacan (`active`) y las demás se retiran (`dim`). */
  emphasis?: 'active' | 'dim'
  live?: boolean
  failed?: boolean
  /** Es un cable de datos que se puede soltar: se puede seleccionar y aparece su botón de desconectar. */
  removable?: boolean
  onRemove?: () => void
}

export type PryselFlowEdge = FlowEdge<PryselEdgeData, 'prysel'>

/** Los contenedores de un nodo, de dentro hacia fuera. */
function ancestors(id: string, parentOf: Record<string, string>): Set<string> {
  const found = new Set<string>()
  for (let up = parentOf[id]; up !== undefined && !found.has(up); up = parentOf[up]) found.add(up)
  return found
}

export function PryselEdge({
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  label,
  markerEnd,
  selected,
}: EdgeProps<PryselFlowEdge>) {
  const relation = data?.relation ?? 'dependency'
  const channel = data?.channel ?? 'data'
  const axis = data?.axis ?? 'horizontal'
  /**
   * Una conexión de flujo que va hacia atrás no es un error: es el salto de línea del plegado.
   * Se traza por detrás, como un retorno de carro, en vez de cruzar el programa en diagonal.
   */
  const wrap =
    relation !== 'feedback' &&
    (axis === 'horizontal' ? targetX < sourceX - 40 : targetY < sourceY - 40)
  const obstacles = data?.obstacles
  const parentOf = data?.parentOf
  const route = useMemo(() => {
    if (wrap || relation === 'feedback' || !obstacles) return null
    // No es obstáculo ni el propio origen o destino, ni el territorio que los envuelve.
    const own = new Set([source, target])
    for (const id of [source, target]) for (const up of ancestors(id, parentOf ?? {})) own.add(up)
    return routeOrthogonal(
      { x: sourceX, y: sourceY },
      { x: targetX, y: targetY },
      obstacles.filter((o) => !own.has(o.id)),
      { axis },
    )
  }, [
    wrap,
    relation,
    obstacles,
    parentOf,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    axis,
  ])

  // Sin camino que esquive (o sin obstáculos que conocer), la curva simple de siempre.
  const path =
    route?.d ??
    routeEdge({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, relation, {
      axis,
      wrap,
      detour: 70,
    })
  const labelAt = route?.mid ?? { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 }

  return (
    <g
      className="edge"
      data-relation={relation}
      data-channel={channel}
      data-wrap={wrap ? '' : undefined}
      data-emphasis={data?.emphasis}
      data-live={data?.live ? '' : undefined}
      data-failed={data?.failed ? '' : undefined}
      data-selected={selected ? '' : undefined}
    >
      {/* Un cable es fino: se ancha su zona de clic para poder seleccionarlo y desconectarlo. */}
      {data?.removable && <path className="edge__hit" d={path} />}
      <path className="edge__line" d={path} markerEnd={markerEnd} />
      {data?.removable && selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="edge__remove nodrag nopan"
            aria-label="Desconectar"
            title="Desconectar (Supr)"
            style={{
              transform: `translate(-50%, -50%) translate(${labelAt.x}px, ${labelAt.y}px)`,
            }}
            onClick={data.onRemove}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
      {data?.live && (
        <circle className="edge__pulse" r={3.5}>
          <animateMotion dur="1.5s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      {label && (
        <EdgeLabelRenderer>
          <div
            className="edge__label-chip type-badge"
            data-emphasis={data?.emphasis}
            style={{
              transform: `translate(-50%, -50%) translate(${labelAt.x}px, ${labelAt.y}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  )
}
