import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeChange,
} from '@xyflow/react'
import {
  getKind,
  nodeSize,
  type Density,
  type Metrics,
  type NodeKindId,
  type NodeState,
} from '@prysel/morphology'
import { layout, type Axis, type SemanticEdge, type SemanticGraph } from '@prysel/spatial'
import { EdgeDefs } from './Edge.tsx'
import { PryselNode, type PryselFlowNode } from './flow/PryselNode.tsx'
import { PryselEdge, type PryselFlowEdge } from './flow/PryselEdge.tsx'
import { useMotion } from './motion.ts'
import type { ControlModel } from './controls.tsx'
import '@xyflow/react/dist/base.css'

/**
 * El lienzo. No coloca nada por su cuenta: pide las posiciones a la gramática espacial,
 * las interpola para que el diagrama se mueva en vez de saltar, y deja que React Flow
 * aporte lo que un lienzo infinito necesita — recorrer, acercar, seleccionar y arrastrar.
 *
 * El reparto es deliberado: la gramática **propone** dónde va cada cosa y el usuario
 * **dispone**; un nodo que se arrastra a mano conserva su sitio hasta que se reordena.
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
  /** Eje de lectura del programa. */
  axis?: Axis
  gapX?: number
  gapY?: number
  /** Altura del lienzo. Sin ella, la que necesite el programa (hasta un máximo razonable). */
  height?: number
  /** Altura mínima, para que una rejilla de ejemplos no quede dentada. */
  minHeight?: number
  /**
   * Permite recorrer, acercar, seleccionar y arrastrar. Desactivado, el lienzo es una
   * ilustración: útil para los ejemplos pequeños, donde poder moverlos solo sería ruido.
   */
  interactive?: boolean
  /** Muestra las acciones de cabecera de cada nodo (duplicar, editar). */
  showActions?: boolean
  /** Muestra el chip de estado de cada nodo. Falso cuando no hay ejecución que mostrar. */
  showStatus?: boolean
  /** Anima los cambios de posición. Desactívalo en lienzos enormes. */
  animate?: boolean
  /**
   * Cómo se encuadra el programa. `contain` lo enseña entero — para una ilustración.
   * `width` ajusta al ancho y deja recorrer hacia abajo, que es como se lee un documento
   * y lo que mantiene los nodos a tamaño legible por largo que sea el programa.
   */
  fitMode?: 'contain' | 'width'
  /** Etiqueta accesible del lienzo, leída por lectores de pantalla. */
  ariaLabel?: string
  className?: string
}

const NODE_TYPES = { prysel: PryselNode }
const EDGE_TYPES = { prysel: PryselEdge }
/** Alto máximo por defecto: a partir de aquí, el lienzo se recorre en vez de crecer. */
const MAX_HEIGHT = 640

/** ¿Es este nodo un contenedor de alcance (una abstracción con hijos)? */
function isScopeNode(node: CanvasNode): boolean {
  return getKind(node.kind).role === 'abstraction' && (node.contains?.length ?? 0) > 0
}

export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function CanvasInner({
  nodes,
  edges,
  density,
  stateOf,
  onControlChange,
  onEnter,
  axis = 'horizontal',
  gapX,
  gapY,
  height,
  minHeight = 0,
  interactive = false,
  showActions = true,
  showStatus = true,
  animate = true,
  fitMode,
  ariaLabel,
  className,
}: CanvasProps) {
  /** Posiciones que el usuario ha movido a mano: mandan sobre las que propone la gramática. */
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({})
  /** El lienzo se reencuadra solo hasta que el usuario lo recorre: a partir de ahí, manda él. */
  const [taken, setTaken] = useState(false)
  const { setViewport } = useReactFlow()
  const frameRef = useRef<HTMLDivElement>(null)
  const lastFit = useRef('')

  const densityOf = useCallback(
    (node: CanvasNode): Density => (density === 'normal' ? (node.density ?? 'normal') : density),
    [density],
  )

  const { placements, bounds } = useMemo(() => {
    const graph: SemanticGraph = {
      nodes: nodes.map((node) => {
        const spec = getKind(node.kind)
        return {
          id: node.id,
          role: spec.role,
          size: nodeSize(spec, densityOf(node), node.metrics),
          ...(node.contains ? { contains: node.contains } : {}),
        }
      }),
      edges,
    }
    return layout(graph, {
      axis,
      ...(gapX === undefined ? {} : { gapX }),
      ...(gapY === undefined ? {} : { gapY }),
    })
  }, [nodes, edges, densityOf, axis, gapX, gapY])

  /** Qué campos de cada nodo reciben una conexión: lo dice el grafo, no la interfaz. */
  const linked = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const edge of edges) {
      if (!edge.toPort) continue
      map[edge.to] = [...(map[edge.to] ?? []), edge.toPort]
    }
    return map
  }, [edges])

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])

  // El destino tiene que ser estable entre renders: si cambia de identidad en cada uno,
  // la animación se relanzaría sin parar en vez de avanzar.
  const motionItems = useMemo(
    () =>
      placements.map((placement) => ({
        id: placement.id,
        value: placement,
        position: moved[placement.id] ?? { x: placement.x, y: placement.y },
      })),
    [placements, moved],
  )

  // El movimiento: las posiciones se interpolan, así que un nodo se puede seguir con la vista.
  const animated = useMotion(motionItems, { disabled: !animate })

  const flowNodes: PryselFlowNode[] = animated.flatMap((item) => {
    const node = byId.get(item.id)
    if (!node) return []
    const container = isScopeNode(node)
    return [
      {
        id: item.id,
        type: 'prysel' as const,
        position: item.position,
        width: item.value.size.w,
        height: item.value.size.h,
        initialWidth: item.value.size.w,
        initialHeight: item.value.size.h,
        // El contenedor va por detrás: su territorio enmarca a los nodos que abarca.
        zIndex: container ? 0 : 1,
        draggable: interactive,
        selectable: interactive,
        data: {
          node,
          density: densityOf(node),
          state: stateOf?.(node.id) ?? 'dormant',
          axis,
          size: item.value.size,
          container,
          showActions,
          showStatus,
          linkedSlots: linked[node.id] ?? [],
          phase: item.phase,
          ...(onControlChange ? { onControlChange } : {}),
          ...(onEnter ? { onEnter } : {}),
        },
      },
    ]
  })

  const flowEdges: PryselFlowEdge[] = edges.map((edge) => ({
    id: `${edge.from}-${edge.to}-${edge.toPort ?? ''}-${edge.relation}`,
    source: edge.from,
    target: edge.to,
    sourceHandle: edge.fromPort ?? 'out',
    targetHandle: edge.toPort ?? 'in',
    type: 'prysel' as const,
    ...(edge.label === undefined ? {} : { label: edge.label }),
    markerEnd: `url(#prysel-arrow-${edge.relation === 'transform' ? 'thick' : 'thin'})`,
    data: {
      relation: edge.relation,
      axis,
      live:
        stateOf !== undefined && stateOf(edge.from) === 'success' && stateOf(edge.to) !== 'dormant',
    },
  }))

  const onNodesChange = useCallback((changes: NodeChange<PryselFlowNode>[]) => {
    for (const change of changes) {
      if (change.type !== 'position' || !change.position) continue
      const { id, position } = change
      setMoved((current) => ({ ...current, [id]: position }))
    }
  }, [])

  // Al cambiar el programa, el encuadre se rehace — salvo que el usuario ya lo haya movido.
  const shape = `${bounds.w}x${bounds.h}:${placements.length}`
  /**
   * El encuadre lo calcula la propia gramática: ya sabe cuánto ocupa el programa, así que
   * no hace falta que la vista lo redescubra midiendo el DOM (que además llega tarde).
   */
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || taken) return
    const fit = () => {
      const pad = 24
      const byWidth = Math.max(0.15, (frame.clientWidth - pad * 2) / bounds.w)
      const byHeight = Math.max(0.15, (frame.clientHeight - pad * 2) / bounds.h)
      // Un lienzo de trabajo se ajusta al ancho y se recorre; una ilustración se enseña entera.
      const mode = fitMode ?? (interactive ? 'width' : 'contain')
      const zoom = Math.min(1, mode === 'width' ? byWidth : Math.min(byWidth, byHeight))
      const first = lastFit.current === ''
      lastFit.current = shape
      void setViewport(
        {
          x: (frame.clientWidth - bounds.w * zoom) / 2,
          y: Math.max(pad, (frame.clientHeight - bounds.h * zoom) / 2),
          zoom,
        },
        { duration: first || !animate ? 0 : 300 },
      )
    }
    if (shape !== lastFit.current) fit()
    // Si cambia el tamaño del lienzo, el encuadre se rehace.
    const observer = new ResizeObserver(fit)
    observer.observe(frame)
    return () => {
      observer.disconnect()
    }
  }, [shape, taken, setViewport, animate, bounds.w, bounds.h, fitMode, interactive])

  const onMoveStart = useCallback((event: unknown) => {
    // Un movimiento sin evento es programático (el propio reencuadre): no cuenta como tomar el control.
    if (event) setTaken(true)
  }, [])

  const canvasHeight = height ?? Math.max(minHeight, Math.min(bounds.h, MAX_HEIGHT))

  return (
    <div
      className={['canvas stage rounded-lg border border-border-card', className]
        .filter(Boolean)
        .join(' ')}
      ref={frameRef}
      style={{ height: canvasHeight }}
      data-interactive={interactive ? '' : undefined}
      role="group"
      aria-label={ariaLabel ?? 'Diagrama del programa'}
    >
      {/* Las puntas de flecha viven en un svg propio: React Flow no las declara por nosotros. */}
      <svg className="canvas__defs" aria-hidden>
        <EdgeDefs />
      </svg>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={interactive ? onNodesChange : undefined}
        onMoveStart={interactive ? onMoveStart : undefined}
        minZoom={0.15}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={interactive}
        nodesConnectable={false}
        elementsSelectable={interactive}
        panOnDrag={interactive}
        zoomOnScroll={interactive}
        zoomOnPinch={interactive}
        zoomOnDoubleClick={false}
        preventScrolling={interactive}
        // Sin interacción el lienzo es una ilustración: no debe robar el foco al recorrer la página.
        nodesFocusable={interactive}
        edgesFocusable={false}
        autoPanOnNodeDrag={false}
      >
        {interactive && <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />}
      </ReactFlow>
    </div>
  )
}
