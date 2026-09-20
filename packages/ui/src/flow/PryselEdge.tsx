import { EdgeLabelRenderer, type EdgeProps, type Edge as FlowEdge } from '@xyflow/react'
import { routeEdge, type Axis, type Relation } from '@prysel/spatial'

/**
 * Una conexión dentro de React Flow, trazada por la gramática de conexiones.
 * React Flow aporta los extremos (ya sabe dónde está cada puerto); el trazado —grosor,
 * punta y curvatura— sigue saliendo de `routeEdge`, porque es ahí donde vive el significado.
 */

export interface PryselEdgeData extends Record<string, unknown> {
  relation: Relation
  axis: Axis
  live?: boolean
  failed?: boolean
}

export type PryselFlowEdge = FlowEdge<PryselEdgeData, 'prysel'>

export function PryselEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  label,
  markerEnd,
}: EdgeProps<PryselFlowEdge>) {
  const relation = data?.relation ?? 'dependency'
  const axis = data?.axis ?? 'horizontal'
  /**
   * Una conexión de flujo que va hacia atrás no es un error: es el salto de línea del plegado.
   * Se traza por detrás, como un retorno de carro, en vez de cruzar el programa en diagonal.
   */
  const wrap =
    relation !== 'feedback' &&
    (axis === 'horizontal' ? targetX < sourceX - 40 : targetY < sourceY - 40)
  const path = routeEdge({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, relation, {
    axis,
    wrap,
    detour: 70,
  })

  return (
    <g
      className="edge"
      data-relation={relation}
      data-wrap={wrap ? '' : undefined}
      data-live={data?.live ? '' : undefined}
      data-failed={data?.failed ? '' : undefined}
    >
      <path className="edge__line" d={path} markerEnd={markerEnd} />
      {data?.live && (
        <circle className="edge__pulse" r={3.5}>
          <animateMotion dur="1.5s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      {label && (
        <EdgeLabelRenderer>
          <div
            className="edge__label-chip type-badge"
            style={{
              transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${(sourceY + targetY) / 2}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  )
}
