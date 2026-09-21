import { useCallback, useEffect, useState } from 'react'
import { Handle, Position, useUpdateNodeInternals, type NodeProps, type Node } from '@xyflow/react'
import {
  buildShape,
  docHeadroom,
  getKind,
  shapeFor,
  slotTypeOf,
  type Density,
  type NodeState,
} from '@prysel/morphology'
import { SCOPE_FRAME, type Axis } from '@prysel/spatial'
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
 *
 * Los puertos son de dos clases. Los de **entrada** (uno por campo que acepta un valor, a su
 * altura) y el de **salida** (lo que el nodo deja definido) se conectan arrastrando; una función
 * ofrece además un puerto de salida por **parámetro**, en el borde de su territorio, hacia lo que
 * lleva dentro.
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
  /** Se puede conectar arrastrando: el lienzo es interactivo y hay dónde escribir lo que se conecte. */
  connectable: boolean
  /** Mientras se arrastra un cable: los campos de este nodo donde soltarlo valdría (`null` si no se arrastra). */
  eligible: string[] | null
  phase: MotionPhase
  onControlChange?: (id: string, next: ControlModel) => void
  onNodeEdit?: (id: string, edit: NodeEdit) => void
  onEnter?: (id: string) => void
}

export type PryselFlowNode = Node<PryselNodeData, 'prysel'>

/** Cuánto se separan los puertos de los parámetros a lo largo del borde de su función. */
const PARAM_STEP = 26

export function PryselNode({ id, data, selected }: NodeProps<PryselFlowNode>) {
  const { node, density, state, axis, size, container, linkedSlots, connectable, eligible, phase } =
    data
  const [slots, setSlots] = useState<MeasuredSlot[]>([])
  const updateNodeInternals = useUpdateNodeInternals()

  const spec = getKind(node.kind)
  const geo = buildShape(container ? spec.shape : shapeFor(spec, density), size.w, size.h)
  const horizontal = axis === 'horizontal'

  const handleSlots = useCallback((measured: MeasuredSlot[]) => {
    setSlots(measured)
  }, [])

  const inputs = node.inputs ?? []
  const connected = slots.filter((slot) => linkedSlots.includes(slot.id))
  /** Campos que aceptan un cable y aún no lo tienen: su puerto está libre, esperando. */
  const open = connectable
    ? slots.filter((slot) => inputs.includes(slot.id) && !linkedSlots.includes(slot.id))
    : []
  /** Los parámetros de una función que se dibuja como territorio: puertos de salida a su interior. */
  const params = container && connectable ? (node.params ?? []) : []
  const paramY = (index: number) =>
    Math.min(
      size.h - 18,
      SCOPE_FRAME.top + (node.note ? docHeadroom(node.note) : 0) + 8 + index * PARAM_STEP,
    )
  const paramX = (index: number) => Math.min(size.w - 18, SCOPE_FRAME.top + 8 + index * PARAM_STEP)
  const paramAt = (index: number) => (horizontal ? paramY(index) : paramX(index))

  // Dónde están los puertos depende de la forma del nodo, de su tamaño y de dónde ha quedado cada
  // campo conectado. Como el nodo llega ya medido, React Flow no se entera de que eso cambió:
  // hay que decírselo, y **después** de pintar, cuando los puertos nuevos ya existen en el DOM.
  const portLayout = [
    `${size.w}x${size.h}`,
    density,
    axis,
    container,
    connectable,
    ...connected.map((slot) => `${slot.id}@${slot.y}`),
    ...open.map((slot) => `${slot.id}@${slot.y}`),
    ...params,
  ].join('|')
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, updateNodeInternals, portLayout])
  const targetSide = horizontal ? Position.Left : Position.Top
  const sourceSide = horizontal ? Position.Right : Position.Bottom
  /** Coloca un puerto a lo largo del borde correspondiente. */
  const along = (value: number) => (horizontal ? { top: value } : { left: value })

  const takesInput = spec.ports.in || inputs.length > 0
  const gives = spec.ports.out || node.provides !== undefined
  /** Los campos que enseñan su nombre: los que reciben un cable, y (al arrastrar uno) donde valdría soltarlo. */
  const named = [...connected, ...open.filter((slot) => eligible?.includes(slot.id))]

  return (
    <div className="flow-node" data-phase={phase} data-selected={selected ? '' : undefined}>
      {takesInput && (
        <>
          {/* El puerto genérico existe siempre: es el que usa una conexión sin campo concreto. */}
          {spec.ports.in && (
            <Handle
              type="target"
              id="in"
              position={targetSide}
              style={along(horizontal ? geo.handles.in.y : geo.handles.in.x)}
              isConnectable={false}
            />
          )}
          {[...connected, ...open].map((slot) => (
            <Handle
              key={slot.id}
              type="target"
              id={slot.id}
              position={targetSide}
              style={along(slot.y)}
              title={slot.label}
              isConnectable={connectable && inputs.includes(slot.id)}
              data-type={slotTypeOf(node.control, slot.id)}
              data-open={linkedSlots.includes(slot.id) ? undefined : ''}
              data-eligible={eligible?.includes(slot.id) ? '' : undefined}
            />
          ))}
          {/* Cada cable que entra dice a qué campo llega: sin esto, dos cables al mismo nodo son ambiguos. */}
          {named.map((slot) => (
            <span
              key={`label:${slot.id}`}
              className="port-label type-badge"
              data-side={horizontal ? 'left' : 'top'}
              data-eligible={eligible?.includes(slot.id) ? '' : undefined}
              style={along(slot.y)}
              aria-hidden
            >
              {slot.label}
            </span>
          ))}
        </>
      )}

      {gives && (
        <Handle
          type="source"
          id="out"
          position={sourceSide}
          style={along(horizontal ? geo.handles.out.y : geo.handles.out.x)}
          isConnectable={connectable && node.provides !== undefined}
          {...(node.provides === undefined
            ? {}
            : { title: node.provides, 'data-type': node.valueType ?? 'any', 'data-gives': '' })}
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

      {/* Los parámetros de la función: de aquí salen los cables hacia lo que hay dentro de ella. */}
      {params.map((name, index) => (
        <Handle
          key={`param:${name}`}
          type="source"
          id={`param:${name}`}
          position={targetSide}
          style={along(paramAt(index))}
          title={`Parámetro ${name}`}
          isConnectable
          data-type="any"
          data-gives=""
          data-param=""
        />
      ))}
      {params.map((name, index) => (
        <span
          key={`param-label:${name}`}
          className="port-label type-badge"
          data-side={horizontal ? 'inside' : 'inside-top'}
          style={along(paramAt(index))}
          aria-hidden
        >
          {name}
        </span>
      ))}

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
