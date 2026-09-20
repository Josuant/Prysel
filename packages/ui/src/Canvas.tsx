import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildShape,
  getKind,
  nodeSize,
  shapeFor,
  type Density,
  type Metrics,
  type NodeKindId,
  type NodeState,
} from '@prysel/morphology'
import {
  layout,
  routeEdge,
  type SemanticEdge,
  type SemanticGraph,
  type SemanticNode,
} from '@prysel/spatial'
import { Edge, EdgeDefs } from './Edge.tsx'
import { MorphNode, type MeasuredSlot } from './MorphNode.tsx'
import type { ControlModel } from './controls.tsx'

/**
 * El lienzo. No coloca nada por su cuenta: pide las posiciones a la gramática espacial
 * y se limita a dibujar. Las conexiones aterrizan en el puerto exacto del campo que alimentan.
 */

export interface CanvasNode {
  id: string
  kind: NodeKindId
  label: string
  code?: string
  meta?: string
  metrics?: Metrics
  control?: ControlModel
  /** Densidad propia; sin ella manda la del lienzo. */
  density?: Density
  contains?: string[]
  /** Se puede entrar en él: baja un nivel de abstracción. */
  openable?: boolean
}

export interface CanvasProps {
  nodes: CanvasNode[]
  edges: SemanticEdge[]
  density: Density
  stateOf?: (id: string) => NodeState
  onControlChange?: (id: string, next: ControlModel) => void
  onEnter?: (id: string) => void
  /** Aleja el lienzo hasta que el programa entero cabe, como cualquier canvas infinito. */
  fit?: boolean
  gapX?: number
  gapY?: number
  /** Altura mínima, para que una rejilla de ejemplos no quede dentada. */
  minHeight?: number
  className?: string
}

export function Canvas({
  nodes,
  edges,
  density,
  stateOf,
  onControlChange,
  onEnter,
  fit = true,
  gapX,
  gapY,
  minHeight = 0,
  className,
}: CanvasProps) {
  const [slots, setSlots] = useState<Record<string, MeasuredSlot[]>>({})
  const frameRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  const densityOf = useCallback(
    (node: CanvasNode): Density => (density === 'normal' ? (node.density ?? 'normal') : density),
    [density],
  )

  const { placements, bounds, regions } = useMemo(() => {
    const semantic: SemanticNode[] = nodes.map((node) => {
      const spec = getKind(node.kind)
      return {
        id: node.id,
        role: spec.role,
        size: nodeSize(spec, densityOf(node), node.metrics),
        ...(node.contains ? { contains: node.contains } : {}),
      }
    })
    const graph: SemanticGraph = { nodes: semantic, edges }
    return layout(graph, {
      ...(gapX === undefined ? {} : { gapX }),
      ...(gapY === undefined ? {} : { gapY }),
    })
  }, [nodes, edges, densityOf, gapX, gapY])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? bounds.w
      setScale(fit ? Math.min(1, width / bounds.w) : 1)
    })
    observer.observe(frame)
    return () => {
      observer.disconnect()
    }
  }, [fit, bounds.w])

  const placementOf = (id: string) => placements.find((p) => p.id === id)

  /** Qué campos de cada nodo reciben una conexión: lo dice el grafo, no la interfaz. */
  const linked = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const edge of edges) {
      if (!edge.toPort) continue
      map[edge.to] = [...(map[edge.to] ?? []), edge.toPort]
    }
    return map
  }, [edges])

  const inPoint = (edge: SemanticEdge) => {
    const p = placementOf(edge.to)
    if (!p) return null
    const slot = edge.toPort ? slots[edge.to]?.find((s) => s.id === edge.toPort) : undefined
    if (slot) return { x: p.x, y: p.y + slot.y }
    const node = nodes.find((n) => n.id === edge.to)
    if (!node) return null
    const geo = buildShape(shapeFor(getKind(node.kind), densityOf(node)), p.size.w, p.size.h)
    return { x: p.x + geo.handles.in.x, y: p.y + geo.handles.in.y }
  }

  const outPoint = (edge: SemanticEdge) => {
    const p = placementOf(edge.from)
    const node = nodes.find((n) => n.id === edge.from)
    if (!p || !node) return null
    const geo = buildShape(shapeFor(getKind(node.kind), densityOf(node)), p.size.w, p.size.h)
    const handle = edge.fromPort === 'alt' && geo.handles.alt ? geo.handles.alt : geo.handles.out
    return { x: p.x + handle.x, y: p.y + handle.y }
  }

  return (
    <div
      ref={frameRef}
      className={['stage overflow-hidden rounded-lg border border-border-card', className]
        .filter(Boolean)
        .join(' ')}
      style={{ height: Math.max(bounds.h * scale, minHeight) }}
      data-regions={regions.map((r) => r.topology).join(' ')}
    >
      <div
        className="relative"
        style={{
          width: bounds.w,
          height: bounds.h,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        <svg className="edges" width={bounds.w} height={bounds.h} aria-hidden>
          <EdgeDefs />
          {edges.map((edge) => {
            const a = outPoint(edge)
            const b = inPoint(edge)
            if (!a || !b) return null
            const path = routeEdge(a, b, edge.relation)
            const live =
              stateOf !== undefined &&
              stateOf(edge.from) === 'success' &&
              stateOf(edge.to) !== 'dormant'
            return (
              <Edge
                key={`${edge.from}-${edge.to}-${edge.toPort ?? ''}`}
                path={path}
                relation={edge.relation}
                live={live}
                {...(edge.label
                  ? { label: edge.label, labelAt: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
                  : {})}
              />
            )
          })}
        </svg>

        {nodes.map((node) => {
          const p = placementOf(node.id)
          if (!p) return null
          return (
            <MorphNode
              key={node.id}
              kind={node.kind}
              label={node.label}
              code={node.code}
              meta={node.meta}
              metrics={node.metrics}
              control={node.control}
              density={densityOf(node)}
              state={stateOf?.(node.id) ?? 'dormant'}
              linkedSlots={linked[node.id] ?? []}
              onSlotsMeasured={(measured) => {
                setSlots((current) =>
                  JSON.stringify(current[node.id]) === JSON.stringify(measured)
                    ? current
                    : { ...current, [node.id]: measured },
                )
              }}
              onControlChange={(next) => onControlChange?.(node.id, next)}
              {...(node.openable && onEnter ? { onToggleDensity: () => onEnter(node.id) } : {})}
              style={{ position: 'absolute', left: p.x, top: p.y }}
            />
          )
        })}
      </div>
    </div>
  )
}
