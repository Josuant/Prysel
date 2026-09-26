import { useId, useMemo } from 'react'
import { EdgeLabelRenderer, type EdgeProps, type Edge as FlowEdge } from '@xyflow/react'
import {
  FLOW_JOIN,
  routeEdge,
  routeFlow,
  routeOrthogonal,
  type Axis,
  type FlowExit,
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
  /** Va a una nota: se dibuja a mano, como una flecha de rotulador. */
  note?: boolean
  /** Es un cable de datos que se puede soltar: se puede seleccionar y aparece su botón de desconectar. */
  removable?: boolean
  onRemove?: () => void
  /**
   * Es la secuencia de un diagrama de flujo: se traza en ángulos rectos por el hueco que dejó la colocación.
   * `exit` dice si sale por abajo o por el vértice derecho de un rombo; `lane`, por dónde baja un «no» sin
   * `else`; `join`, que llegan varios caminos a ese paso (y se dibuja el punto donde se juntan); `tag`, «sí» o
   * «no» junto al vértice.
   */
  flow?: { exit: FlowExit; lane?: number; join: boolean; tag?: string; bend?: number }
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
  const flow = data?.flow
  const route = useMemo(() => {
    if (flow) {
      return routeFlow(
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY },
        {
          exit: flow.exit,
          ...(flow.lane === undefined ? {} : { lane: flow.lane }),
          ...(flow.bend === undefined ? {} : { join: flow.bend }),
        },
      )
    }
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
    flow,
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
  const handId = `hand-${useId().replace(/:/g, '')}`
  // El temblor del trazo es un filtro de este cable, con su región a su medida: en un trazo recto, la
  // caja del propio trazo no tiene alto, y un filtro sobre ella lo haría desaparecer.
  const hand = data?.note
    ? {
        x: Math.min(sourceX, targetX) - 80,
        y: Math.min(sourceY, targetY) - 80,
        width: Math.abs(targetX - sourceX) + 160,
        height: Math.abs(targetY - sourceY) + 160,
      }
    : null

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
      data-note={hand ? '' : undefined}
      data-flow={flow ? flow.exit : undefined}
    >
      {hand && (
        <filter id={handId} filterUnits="userSpaceOnUse" {...hand}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.03"
            numOctaves={2}
            seed={7}
            result="n"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="n"
            scale={4}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      )}
      {/* Un cable es fino: se ancha su zona de clic para poder seleccionarlo y desconectarlo. */}
      {data?.removable && <path className="edge__hit" d={path} />}
      <path
        className="edge__line"
        d={path}
        markerEnd={markerEnd}
        {...(hand ? { filter: `url(#${handId})` } : {})}
      />
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
      {/* Donde se juntan los caminos que llegan a un mismo paso: un punto, como en un diagrama de flujo. */}
      {flow?.join && (
        <circle
          className="edge__join"
          cx={targetX}
          cy={targetY - (flow.bend ?? FLOW_JOIN)}
          r={3.5}
        />
      )}
      {flow?.tag && (
        <EdgeLabelRenderer>
          <div
            className="edge__tag type-badge"
            data-exit={flow.exit}
            data-emphasis={data?.emphasis}
            style={{
              transform:
                flow.exit === 'right'
                  ? `translate(${sourceX + 8}px, ${sourceY - 18}px)`
                  : `translate(${sourceX + 7}px, ${sourceY + 3}px)`,
            }}
          >
            {flow.tag}
          </div>
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
