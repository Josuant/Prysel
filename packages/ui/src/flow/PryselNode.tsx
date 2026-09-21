import { useCallback, useEffect, useState } from 'react'
import {
  Handle,
  NodeResizeControl,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
  type Node,
} from '@xyflow/react'
import {
  buildShape,
  getKind,
  shapeFor,
  slotTypeOf,
  type ValueType,
  type Density,
  type NodeState,
} from '@prysel/morphology'
import { PARAM_GUTTER, SCOPE_FRAME, type Axis } from '@prysel/spatial'
import { MorphNode, type MeasuredSlot, type NodeEdit } from '../MorphNode.tsx'
import type { ControlModel } from '../controls.tsx'
import type { MotionPhase } from '../motion.ts'
import type { CanvasNode } from '../Canvas.tsx'
import { isLoopTerritory, territoryHeadroom } from './frame.ts'
import { TrayBox } from './ChipNode.tsx'
import { TRAY, type TrayLayout } from '../chips.ts'
import { Icon } from '../Icon.tsx'

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
  /** Sube cada vez que el menú del nodo pide renombrarlo. */
  renameSignal?: number
  showStatus: boolean
  linkedSlots: string[]
  /** Se puede conectar arrastrando: el lienzo es interactivo y hay dónde escribir lo que se conecte. */
  connectable: boolean
  /** Mientras se arrastra un cable: los campos de este nodo donde soltarlo valdría (`null` si no se arrastra). */
  eligible: string[] | null
  /** Mientras se arrastra un nodo: esta función lo recibiría (`into`) o lo perdería (`out`). */
  drop?: 'into' | 'out' | undefined
  /** Aquí irá lo que se añada desde el menú. */
  addTarget?: boolean
  /** La cajita de chips de este contexto, si es un territorio que tiene una. */
  tray?: TrayLayout | undefined
  /** Añadir una variable al principio de este contexto. */
  onAddChip?: (context: string) => void
  /** Las casillas de este nodo que llevan un chip dentro. */
  chipSlots?: Readonly<Record<string, { name: string; type: ValueType }>> | undefined
  /** Las casillas que solo reciben chips: no llevan puerto para un cable. */
  chipOnly?: readonly string[] | undefined
  /** La casilla sobre la que está un chip que se arrastra. */
  hotSlot?: { slot: string; ok: boolean } | null | undefined
  /** Quitar el chip de una casilla. */
  onClearChip?: (id: string, slot: string) => void
  /** A quién se puede llamar: lo que ofrece el desplegable de una llamada. */
  callees?: readonly string[]
  /** Las casillas de este nodo donde se usa el chip seleccionado. */
  litSlots?: readonly string[] | undefined
  /** Se ensancha a mano (solo las funciones dibujadas como territorio). */
  onResize?: (id: string, size: { w: number; h: number }) => void
  phase: MotionPhase
  onControlChange?: (id: string, next: ControlModel) => void
  onNodeEdit?: (id: string, edit: NodeEdit) => void
  onEnter?: (id: string) => void
}

export type PryselFlowNode = Node<PryselNodeData, 'prysel'>

/** Cuánto se separan los puertos de los parámetros a lo largo del borde de su función. */
const PARAM_STEP = 26

/**
 * El carril de repetición de un bucle: sale del final del cuerpo (abajo a la derecha), recorre el
 * borde inferior hacia la izquierda y sube por el lateral hasta la cabecera. Es el retorno de
 * carro de un texto: dice de un vistazo que lo de dentro se repite.
 */
function railPath(w: number, h: number, top: number): string {
  const x0 = 14
  const x1 = w - 20
  const y1 = h - 16
  const r = 8
  return [
    `M ${x1} ${Math.max(top + 24, y1 - 30)}`,
    `V ${y1 - r}`,
    `Q ${x1} ${y1} ${x1 - r} ${y1}`,
    `H ${x0 + r}`,
    `Q ${x0} ${y1} ${x0} ${y1 - r}`,
    `V ${top - 4}`,
  ].join(' ')
}

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
  /** Una función dibujada como territorio recibe su retorno en un puerto del borde derecho. */
  const takesReturn = container && inputs.includes('return')
  /**
   * Dos casillas en la misma fila (`a + b`) tendrían sus puertos uno encima del otro: se reparten a
   * lo alto del borde, alrededor del centro de la fila, para poder elegir cuál.
   */
  const spread = new Map<string, number>()
  {
    const sorted = [...slots].sort((a, b) => a.y - b.y)
    for (let i = 0; i < sorted.length;) {
      const first = sorted[i]
      if (!first) break
      let end = i + 1
      while (end < sorted.length && (sorted[end]?.y ?? 0) - first.y <= 10) end++
      const row = sorted.slice(i, end)
      if (row.length > 1) {
        const mid = row.reduce((sum, slot) => sum + slot.y, 0) / row.length
        row.forEach((slot, index) => {
          spread.set(slot.id, Math.round(mid + (index - (row.length - 1) / 2) * 16))
        })
      }
      i = end
    }
  }
  const yOf = (slot: MeasuredSlot) => spread.get(slot.id) ?? slot.y
  const chipOnly = data.chipOnly ?? []
  // Una casilla que lleva un chip no necesita puerto: el chip está dentro, no llega un cable.
  const connected = slots.filter(
    (slot) => linkedSlots.includes(slot.id) && !chipOnly.includes(slot.id),
  )
  /** Campos que aceptan un cable y aún no lo tienen: su puerto está libre, esperando. */
  const open = connectable
    ? slots.filter((slot) => inputs.includes(slot.id) && !linkedSlots.includes(slot.id))
    : []
  /** Los parámetros de una función que se dibuja como territorio: puertos de salida a su interior. */
  const params = container && connectable ? (node.params ?? []) : []
  /** Donde acaba la cabecera del territorio: el contenido empieza justo debajo. */
  const headTop = SCOPE_FRAME.top + territoryHeadroom(node)
  const tray = container ? data.tray : undefined
  const contentTop = headTop + (tray ? tray.h + TRAY.below : 0)
  /** Lo que hay a la izquierda del contenido de un territorio: su margen y la zona de sus puertos. */
  const insetLeft = SCOPE_FRAME.side + (node.params?.length && node.contains ? PARAM_GUTTER : 0)
  /** Un bucle con cuerpo: envuelve lo que repite, y su variable, su salida y su retorno son puertos. */
  const isLoop = container && isLoopTerritory(node)
  /** Hay un `continue` dentro: su cable vuelve a la cabecera por este puerto. */
  const hasNext = isLoop && linkedSlots.includes('next')
  // Con un `continue`, su puerto ocupa el primer sitio junto a la cabecera: los parámetros bajan un paso.
  const paramY = (index: number) =>
    Math.min(size.h - 18, contentTop + 8 + (hasNext ? PARAM_STEP : 0) + index * PARAM_STEP)
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
    takesReturn,
    isLoop,
    hasNext,
    linkedSlots.includes('exit'),
    contentTop,
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
  const gives =
    spec.ports.out ||
    node.provides !== undefined ||
    node.returns !== undefined ||
    // `break` y `continue` no dan un valor, pero su cable sale hacia el bucle que afectan.
    node.kind === 'control.break' ||
    node.kind === 'control.continue'
  /** Dónde está la salida de un territorio: a media altura de su borde derecho. */
  const middle = horizontal ? geo.handles.out.y : geo.handles.out.x

  /** Los campos que enseñan su nombre: los que reciben un cable, y (al arrastrar uno) donde valdría soltarlo. */
  const named = [...connected, ...open.filter((slot) => eligible?.includes(slot.id))]

  return (
    <div
      className="flow-node"
      data-phase={phase}
      data-selected={selected ? '' : undefined}
      data-add-target={data.addTarget ? '' : undefined}
    >
      {tray && (
        <div className="tray-slot" style={{ left: insetLeft, top: headTop }}>
          <TrayBox
            tray={tray}
            label={`Variables y constantes de ${node.label}`}
            {...(data.onAddChip
              ? {
                  onAdd: () => {
                    data.onAddChip?.(id)
                  },
                }
              : {})}
          />
        </div>
      )}
      {data.drop && (
        <div className="drop-hint" data-drop={data.drop} aria-hidden>
          <span className="drop-hint__label type-badge">
            {data.drop === 'into'
              ? `Suelta para meterlo en «${node.label}»`
              : `Suelta fuera para sacarlo de «${node.label}»`}
          </span>
        </div>
      )}
      {container && selected && data.onResize && (
        <NodeResizeControl
          position="bottom-right"
          minWidth={160}
          minHeight={120}
          className="node-resize"
          onResize={(_, params) => {
            data.onResize?.(id, { w: Math.round(params.width), h: Math.round(params.height) })
          }}
        >
          <span className="node-resize__grip" title="Cambiar el tamaño" />
        </NodeResizeControl>
      )}
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
              style={along(yOf(slot))}
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
              style={along(yOf(slot))}
              aria-hidden
            >
              {slot.label}
            </span>
          ))}
        </>
      )}

      {takesReturn && (
        <>
          <Handle
            type="target"
            id="return"
            position={sourceSide}
            style={along(horizontal ? geo.handles.out.y : geo.handles.out.x)}
            title="Lo que devuelve la función"
            isConnectable={connectable}
            data-type="any"
            data-open={linkedSlots.includes('return') ? undefined : ''}
            data-eligible={eligible?.includes('return') ? '' : undefined}
          />
          <span
            className="port-label type-badge"
            data-side={horizontal ? 'right' : 'bottom'}
            style={along(horizontal ? geo.handles.out.y : geo.handles.out.x)}
            aria-hidden
          >
            devuelve
          </span>
        </>
      )}
      {/* La salida de un bucle: por aquí sale el flujo cuando termina, y aquí llega un `break`. */}
      {isLoop && linkedSlots.includes('exit') && (
        <>
          <Handle
            type="target"
            id="exit"
            position={sourceSide}
            style={along(middle)}
            title="Por aquí sale el flujo cuando el bucle termina"
            isConnectable={false}
            data-type="any"
            data-open={linkedSlots.includes('exit') ? undefined : ''}
          />
          <span
            className="port-label type-badge"
            data-side={horizontal ? 'right' : 'bottom'}
            style={along(middle)}
            aria-hidden
          >
            termina
          </span>
        </>
      )}
      {/* Un `continue` vuelve a la cabecera, no al final: su puerto está junto a ella. */}
      {hasNext && (
        <>
          <Handle
            type="target"
            id="next"
            position={targetSide}
            style={along(Math.max(20, contentTop - 10))}
            title="Salta a la siguiente vuelta"
            isConnectable={false}
            data-type="any"
          />
          <span
            className="port-label type-badge"
            data-side={horizontal ? 'inside' : 'inside-top'}
            data-rail=""
            style={along(Math.max(20, contentTop - 10))}
            aria-hidden
          >
            siguiente
          </span>
        </>
      )}
      {gives && !takesReturn && !isLoop && (
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
          data-rail={isLoop ? '' : undefined}
          style={along(paramAt(index))}
          aria-hidden
        >
          {name}
        </span>
      ))}

      {/* El retorno del bucle: un carril que vuelve del final del cuerpo a la cabecera. */}
      {isLoop && horizontal && (
        <>
          <svg className="loop-rail" width={size.w} height={size.h} aria-hidden>
            <path
              className="loop-rail__line"
              d={railPath(size.w, size.h, contentTop)}
              fill="none"
            />
            <path
              className="loop-rail__head"
              d={`M 9 ${contentTop + 3} L 14 ${contentTop - 5} L 19 ${contentTop + 3}`}
              fill="none"
            />
          </svg>
          <span className="loop-rail__label type-badge" style={{ top: size.h - 16 }}>
            <Icon name="repeat" size={11} />
            repite
          </span>
        </>
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
        renameSignal={data.renameSignal ?? 0}
        showStatus={data.showStatus}
        // Los puertos los dibuja React Flow a partir de los Handle: aquí solo se miden.
        showPorts={false}
        focused={selected}
        linkedSlots={linkedSlots}
        {...(data.chipSlots ? { chipSlots: data.chipSlots } : {})}
        hotSlot={data.hotSlot ?? null}
        {...(data.callees ? { callees: data.callees } : {})}
        {...(data.litSlots ? { litSlots: data.litSlots } : {})}
        {...(data.onClearChip
          ? {
              onClearChip: (slot: string) => {
                data.onClearChip?.(id, slot)
              },
            }
          : {})}
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
