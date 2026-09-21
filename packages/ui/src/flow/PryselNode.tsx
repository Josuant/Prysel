import { useCallback, useEffect, useState } from 'react'
import { Handle, Position, useUpdateNodeInternals, type NodeProps, type Node } from '@xyflow/react'
import { buildShape, getKind, shapeFor, type Density, type NodeState } from '@prysel/morphology'
import type { Axis } from '@prysel/spatial'
import { MorphNode, type MeasuredSlot, type NodeEdit } from '../MorphNode.tsx'
import type { ControlModel } from '../controls.tsx'
import type { MotionPhase } from '../motion.ts'
import type { CanvasNode } from '../Canvas.tsx'

/**
 * Un nodo de Prysel dentro de React Flow.
 *
 * `MorphNode` no sabe nada de React Flow: dibuja la tarjeta y dice dónde ha quedado cada
 * campo conectable. Este envoltorio traduce esas medidas a `Handle`s, que es como React Flow
 * sabe dónde empieza y dónde acaba una conexión. Así el puerto sigue cayendo a la altura
 * exacta del campo que alimenta, igual que antes.
 */

export interface PryselNodeData extends Record<string, unknown> {
  node: CanvasNode
  density: Density
  state: NodeState
  axis: Axis
  size: { w: number; h: number }
  container: boolean
  showActions: boolean
  showStatus: boolean
  linkedSlots: string[]
  phase: MotionPhase
  onControlChange?: (id: string, next: ControlModel) => void
  onNodeEdit?: (id: string, edit: NodeEdit) => void
  onEnter?: (id: string) => void
}

export type PryselFlowNode = Node<PryselNodeData, 'prysel'>

export function PryselNode({ id, data, selected }: NodeProps<PryselFlowNode>) {
  const { node, density, state, axis, size, container, linkedSlots, phase } = data
  const [slots, setSlots] = useState<MeasuredSlot[]>([])
  const updateNodeInternals = useUpdateNodeInternals()

  const spec = getKind(node.kind)
  const geo = buildShape(container ? spec.shape : shapeFor(spec, density), size.w, size.h)
  const horizontal = axis === 'horizontal'

  const handleSlots = useCallback((measured: MeasuredSlot[]) => {
    setSlots(measured)
  }, [])

  const connected = slots.filter((slot) => linkedSlots.includes(slot.id))

  // Dónde están los puertos depende de la forma del nodo, de su tamaño y de dónde ha quedado cada
  // campo conectado. Como el nodo llega ya medido, React Flow no se entera de que eso cambió:
  // hay que decírselo, y **después** de pintar, cuando los puertos nuevos ya existen en el DOM.
  const portLayout = [
    `${size.w}x${size.h}`,
    density,
    axis,
    container,
    ...connected.map((slot) => `${slot.id}@${slot.y}`),
  ].join('|')
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, updateNodeInternals, portLayout])
  const targetSide = horizontal ? Position.Left : Position.Top
  const sourceSide = horizontal ? Position.Right : Position.Bottom
  /** Coloca un puerto a lo largo del borde correspondiente. */
  const along = (value: number) => (horizontal ? { top: value } : { left: value })

  return (
    <div className="flow-node" data-phase={phase} data-selected={selected ? '' : undefined}>
      {spec.ports.in && (
        <>
          {/* El puerto genérico existe siempre: es el que usa una conexión sin campo concreto. */}
          <Handle
            type="target"
            id="in"
            position={targetSide}
            style={along(horizontal ? geo.handles.in.y : geo.handles.in.x)}
            isConnectable={false}
          />
          {connected.map((slot) => (
            <Handle
              key={slot.id}
              type="target"
              id={slot.id}
              position={targetSide}
              style={along(slot.y)}
              title={slot.label}
              isConnectable={false}
            />
          ))}
          {/* Cada cable que entra dice a qué campo llega: sin esto, dos cables al mismo nodo son ambiguos. */}
          {connected.map((slot) => (
            <span
              key={`label:${slot.id}`}
              className="port-label type-badge"
              data-side={horizontal ? 'left' : 'top'}
              style={along(slot.y)}
              aria-hidden
            >
              {slot.label}
            </span>
          ))}
        </>
      )}

      {spec.ports.out && (
        <Handle
          type="source"
          id="out"
          position={sourceSide}
          style={along(horizontal ? geo.handles.out.y : geo.handles.out.x)}
          isConnectable={false}
        />
      )}
      {spec.ports.out && geo.handles.alt && (
        <Handle
          type="source"
          id="alt"
          position={sourceSide}
          style={along(horizontal ? geo.handles.alt.y : geo.handles.alt.x)}
          isConnectable={false}
        />
      )}

      <MorphNode
        kind={node.kind}
        label={node.label}
        code={node.code}
        meta={node.meta}
        note={node.note}
        renamable={node.renamable ?? false}
        {...(data.onNodeEdit ? { onAction: (edit: NodeEdit) => data.onNodeEdit?.(id, edit) } : {})}
        metrics={node.metrics}
        control={node.control}
        {...(node.editable ? { editable: node.editable } : {})}
        {...(node.scope ? { suggestions: node.scope } : {})}
        density={density}
        size={size}
        state={state}
        container={container}
        showActions={data.showActions}
        showStatus={data.showStatus}
        // Los puertos los dibuja React Flow a partir de los Handle: aquí solo se miden.
        showPorts={false}
        focused={selected}
        linkedSlots={linkedSlots}
        onSlotsMeasured={handleSlots}
        // Sin quien reciba el cambio, el editor se enseña pero no se puede escribir en él:
        // un campo que acepta texto y no cambia el programa engaña.
        {...(data.onControlChange
          ? { onControlChange: (next: ControlModel) => data.onControlChange?.(id, next) }
          : {})}
        {...(node.openable && data.onEnter
          ? {
              onToggleDensity: () => data.onEnter?.(id),
              // Una llamada lleva a la función que llama; una función, a plegarse o abrirse.
              ...(node.opens
                ? { toggleLabel: `Ver la función de ${node.label}` }
                : container
                  ? {}
                  : { toggleLabel: `Abrir ${node.label}` }),
            }
          : {})}
      />
    </div>
  )
}
