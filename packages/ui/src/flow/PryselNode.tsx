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
  GATEWAY,
  buildShape,
  getKind,
  shapeFor,
  slotTypeOf,
  territoryShape,
  type Density,
  type NodeState,
} from '@prysel/morphology'
import { SCOPE_FRAME, type Axis, type ModuleRole } from '@prysel/spatial'
import { MorphNode, type MeasuredSlot, type NodeEdit } from '../MorphNode.tsx'
import type { ControlModel } from '../controls.tsx'
import type { MotionPhase } from '../motion.ts'
import type { CanvasNode } from '../Canvas.tsx'
import { FLOW_LANE, FLOW_RAIL, flowEntry, isLoopTerritory, territoryHeadroom } from './frame.ts'
import { TrayBox } from './ChipNode.tsx'
import { LapsStrip } from './LapsStrip.tsx'
import { LAPS_HEADROOM } from '../laps.ts'
import { titledScene } from '../gist.ts'
import { GistCard } from './GistCard.tsx'
import { markOpening, openingNow, unrollDelay } from './opening.ts'
import { SectionCard, SectionFrame } from './SectionCard.tsx'
import { TRAY, resultNames, type ChipSlot, type TrayLayout } from '../chips.ts'
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
  /** `pending`: la reproducción de una lección aún no ha llegado aquí (construcción progresiva). */
  modifier?: 'dead' | 'generating' | 'pending'
  axis: Axis
  size: { w: number; h: number }
  container: boolean
  /** Un territorio leído como diagrama de flujo: dónde cae su espina (por ahí entra y sale la secuencia). */
  spine?: number
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
  /** Por aquí va la reproducción de una traza: el nodo que se está ejecutando en este paso. */
  cursor?: boolean
  /** Una orden acaba de crear o de nombrar este nodo: se resalta un momento (el número cambia con cada vez). */
  spotlit?: number | undefined
  /** Acaba de construirse: entra con su animación (él, y lo que lleva dentro, uno tras otro). */
  born?: boolean
  /** La pieza que se está explicando usa lo que este nodo define: late con ella. */
  echoed?: boolean
  /** Una orden acaba de cambiarlo, o está a punto de quitarlo. */
  change?: 'changed' | 'leaving' | undefined
  /** Una nota nombra este nodo en su `código`, y el puntero está encima de ese trozo. */
  hinted?: boolean
  /** La cajita de chips de este contexto, si es un territorio que tiene una. */
  tray?: TrayLayout | undefined
  /** Añadir una variable al principio de este contexto. */
  onAddChip?: (context: string) => void
  /** Las casillas de este nodo que llevan un chip dentro. */
  chipSlots?: Readonly<Record<string, ChipSlot>> | undefined
  /** Se dibuja en una sola línea (una operación o una llamada), con su resultado como chip. */
  line?: boolean
  /** Se lleva un chip ahora mismo: las casillas ocultas (lo que devuelve una función) se enseñan. */
  chipDragging?: boolean
  /** El usuario agarra el chip del resultado para llevarlo a una casilla. */
  onGrabResult?: (id: string, event: React.PointerEvent<HTMLElement>, name?: string) => void
  /** Las casillas que solo reciben chips: no llevan puerto para un cable. */
  chipOnly?: readonly string[] | undefined
  /** La casilla sobre la que está un chip que se arrastra. */
  hotSlot?: { slot: string; ok: boolean; convert?: boolean } | null | undefined
  /** Quitar el chip de una casilla. */
  onClearChip?: (id: string, slot: string) => void
  /** A quién se puede llamar: lo que ofrece el desplegable de una llamada. */
  callees?: readonly string[]
  /** Las casillas de este nodo donde se usa el chip seleccionado. */
  litSlots?: readonly string[] | undefined
  /** Se ensancha a mano (solo las funciones dibujadas como territorio). */
  onResize?: (id: string, size: { w: number; h: number }) => void
  /**
   * Añadir un paso justo después de este (el «+» que aparece bajo él): dónde se pulsó, en la pantalla, para
   * abrir ahí lo que se puede crear.
   */
  onAddAfter?: (id: string, at: { x: number; y: number }) => void
  phase: MotionPhase
  onControlChange?: (id: string, next: ControlModel) => void
  onNodeEdit?: (id: string, edit: NodeEdit) => void
  onEnter?: (id: string) => void
  /** Probar con otros datos la función de una tarjeta «Qué hace». */
  onGistEdit?: (id: string) => void
  /** En la arquitectura: el papel de este módulo (entrada, datos, lógica, control, salida). */
  role?: ModuleRole
  /** En la arquitectura: cuántos módulos usan lo que este guarda (cuando son muchos, se dice aquí). */
  usedBy?: number
  /** Abrir un subproceso (la función, la clase o el método al que llama) desde su pastilla. */
  onOpen?: (id: string) => void
}

export type PryselFlowNode = Node<PryselNodeData, 'prysel'>

/** Tras estos no sigue nada en su bloque: no ofrecen añadir un paso debajo. */
const JUMP_KINDS: ReadonlySet<string> = new Set([
  'control.return',
  'control.raise',
  'control.break',
  'control.continue',
])

/**
 * El carril de repetición de un bucle leído hacia abajo: desde el pie del cuerpo, en la espina (donde llegan
 * el final del cuerpo, el «no» de su última decisión y los `continue`), recorre el fondo hacia la izquierda,
 * sube por el lateral y vuelve a entrar por arriba, justo antes del primer paso. Es el «vuelve a empezar» de un
 * diagrama de flujo.
 */
function flowRailPath(cx: number, h: number, top: number): string {
  const x0 = 12
  const bottom = h - FLOW_RAIL
  const entry = top - 14
  const r = 8
  return [
    `M ${cx} ${bottom}`,
    `Q ${x0} ${bottom} ${x0} ${bottom - r}`,
    `V ${entry + r}`,
    `Q ${x0} ${entry} ${x0 + r} ${entry}`,
    `H ${cx - r}`,
    `Q ${cx} ${entry} ${cx} ${entry + r}`,
    `V ${top - 2}`,
  ].join(' ')
}

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

export function PryselNode({ id, data, selected, positionAbsoluteY }: NodeProps<PryselFlowNode>) {
  const {
    node,
    density,
    state,
    modifier,
    axis,
    size,
    container,
    linkedSlots,
    connectable,
    eligible,
    phase,
  } = data
  const [slots, setSlots] = useState<MeasuredSlot[]>([])
  // Si nace mientras una función se abre desde su tarjeta, se despliega a su turno (los de arriba, antes).
  // Se decide una vez, al nacer: después ya es un nodo como cualquier otro.
  const [unroll] = useState(() => unrollDelay(id, positionAbsoluteY))
  const arriving =
    unroll === null
      ? {}
      : { 'data-unroll': '', style: { '--unroll': `${unroll}ms` } as React.CSSProperties }
  const updateNodeInternals = useUpdateNodeInternals()

  const spec = getKind(node.kind)
  const horizontal = axis === 'horizontal'
  /**
   * Leído hacia abajo, el lienzo es un diagrama de flujo: solo la secuencia tiene puertos (entra arriba, sale
   * abajo), y las variables van en chips, sin cables. Una decisión es un rombo.
   */
  const flow = !horizontal
  /**
   * Una decisión, leída como diagrama de flujo: la pregunta en una píldora y, debajo, el rombo donde se parte
   * el camino («sí» por su vértice de abajo, «no» por el de la derecha).
   */
  const diamond = flow && !container && node.kind === 'control.condition'
  const geo = buildShape(container ? territoryShape(spec) : shapeFor(spec, density), size.w, size.h)
  /** Lo que ocupa la pregunta: todo el nodo menos el tramo de espina y el rombo de debajo. */
  const cardSize = diamond ? { w: size.w, h: size.h - GATEWAY.gap - GATEWAY.size } : size
  /** El centro del rombo de la bifurcación. */
  const gate = { x: size.w / 2, y: size.h - GATEWAY.size / 2 }

  const handleSlots = useCallback((measured: MeasuredSlot[]) => {
    setSlots(measured)
  }, [])

  const inputs = node.inputs ?? []
  /** Lo que asigna una línea, ofrecido como chips (uno, o uno por cada nombre de `a, b = f()`). */
  const results = resultNames(node, density)
  /** Una función dibujada como territorio recibe su retorno en un puerto del borde derecho. */
  const takesReturn = container && inputs.includes('return')
  /** Lo que devuelve, cuando es una variable: una pastilla en el borde, no un cable. */
  const returnChip = takesReturn ? data.chipSlots?.['return'] : undefined
  /** Lo que devuelve es un valor sin nombre (`return a + b`): ese sí es un cable. */
  const returnCable =
    !flow &&
    takesReturn &&
    ((linkedSlots.includes('return') && !(data.chipOnly ?? []).includes('return')) ||
      eligible?.includes('return') === true)
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
  /** Donde acaba la cabecera del territorio: el contenido empieza justo debajo. */
  const headTop = SCOPE_FRAME.top + territoryHeadroom(node)
  const tray = container ? data.tray : undefined
  const contentTop = headTop + (tray ? tray.h + TRAY.below : 0) + flowEntry(node, !horizontal)
  /** Lo que hay a la izquierda del contenido de un territorio: su margen y la zona de sus puertos. */
  const insetLeft = SCOPE_FRAME.side
  /** Un bucle con cuerpo: envuelve lo que repite, y su variable, su salida y su retorno son puertos. */
  const isLoop = container && isLoopTerritory(node)
  /** Por dónde baja la secuencia de un territorio: su espina (en el centro, si no dice otra cosa). */
  const spineX = data.spine ?? size.w / 2
  const spineStyle = data.spine === undefined ? undefined : { left: data.spine }
  /** Hay un `continue` dentro: su cable vuelve a la cabecera por este puerto. */
  const hasNext = isLoop && linkedSlots.includes('next')

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
    spineX,
    ...connected.map((slot) => `${slot.id}@${slot.y}`),
    ...open.map((slot) => `${slot.id}@${slot.y}`),
    returnCable,
  ].join('|')
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, updateNodeInternals, portLayout])
  const targetSide = horizontal ? Position.Left : Position.Top
  const sourceSide = horizontal ? Position.Right : Position.Bottom
  // Los puertos de orden van en el otro eje que los de datos: arriba y abajo si el plano corre a lo ancho.
  const orderIn = horizontal ? Position.Top : Position.Left
  const orderOut = horizontal ? Position.Bottom : Position.Right
  /** Reparte un puerto de orden a lo largo del borde por el que sale (un porcentaje del borde). */
  const acrossEdge = (percent: number) =>
    horizontal ? { left: `${percent}%` } : { top: `${percent}%` }
  /** En compacto la tarjeta es una píldora: no hay sitio para más puertos. */
  const isCompactCard = density === 'compact' && !container
  /** Coloca un puerto a lo largo del borde correspondiente. */
  const along = (value: number) => (horizontal ? { top: value } : { left: value })

  // Sin cables de datos no hay puertos de datos: una casilla recibe chips, no conexiones.
  const takesInput = !flow && (spec.ports.in || inputs.length > 0)
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

  // Una función plegada de la que se sabe qué hace: su tarjeta «Qué hace» (lo que entró → lo que salió).
  if (node.gist && !container) {
    return (
      <div
        className="flow-node"
        data-phase={phase}
        data-gist=""
        data-selected={selected ? '' : undefined}
        data-add-target={data.addTarget ? '' : undefined}
        data-cursor={data.cursor ? '' : undefined}
        data-spotlit={data.spotlit === undefined ? undefined : data.spotlit % 2}
        data-born={data.born ? '' : undefined}
        data-echo={data.echoed ? '' : undefined}
        data-change={data.change}
        data-hinted={data.hinted ? '' : undefined}
        data-modifier={modifier}
        {...arriving}
      >
        <Handle
          type="source"
          id="note-out"
          position={Position.Right}
          isConnectable={false}
          className="note-handle"
        />
        <Handle
          type="source"
          id="aux-out"
          position={Position.Left}
          isConnectable={false}
          className="note-handle"
        />
        {axis === 'vertical' && (
          <>
            <Handle
              type="target"
              id="step-in"
              position={Position.Top}
              isConnectable={false}
              className="note-handle"
              {...(spineStyle ? { style: spineStyle } : {})}
            />
            <Handle
              type="source"
              id="step-out"
              position={Position.Bottom}
              isConnectable={false}
              className="note-handle"
              {...(spineStyle ? { style: spineStyle } : {})}
            />
          </>
        )}
        <GistCard
          scene={titledScene(node.gist, {
            ...(node.section ? { stage: node.section.title } : {}),
            ...(node.note ? { note: node.note } : {}),
          })}
          size={size}
          onToggle={
            data.onEnter
              ? () => {
                  markOpening({ id, w: size.w, h: size.h, y: positionAbsoluteY })
                  data.onEnter?.(id)
                }
              : undefined
          }
          onEdit={
            data.onGistEdit
              ? () => {
                  data.onGistEdit?.(id)
                }
              : undefined
          }
        />
      </div>
    )
  }

  // La función que se acaba de abrir desde su tarjeta: su marco crece desde lo que medía la tarjeta.
  const from = container ? openingNow() : null
  const opened =
    from?.id === id
      ? ({ '--from-w': `${from.w}px`, '--from-h': `${from.h}px` } as React.CSSProperties)
      : null

  // Una etapa (o un bucle que encabeza una, plegado): su tarjeta o su marco, no una tarjeta de sentencia.
  const stage = node.section
  if (stage && (node.kind === 'space.section' || !container)) {
    const retitle = data.onNodeEdit
      ? (to: string) => {
          data.onNodeEdit?.(id, { type: 'rename', to })
        }
      : undefined
    const toggle = data.onEnter
      ? () => {
          data.onEnter?.(id)
        }
      : undefined
    return (
      <div
        className="flow-node"
        data-phase={phase}
        data-section=""
        data-role={data.role}
        data-selected={selected ? '' : undefined}
        data-add-target={data.addTarget ? '' : undefined}
        data-cursor={data.cursor ? '' : undefined}
        data-spotlit={data.spotlit === undefined ? undefined : data.spotlit % 2}
        data-born={data.born ? '' : undefined}
        data-echo={data.echoed ? '' : undefined}
        data-change={data.change}
        data-hinted={data.hinted ? '' : undefined}
        data-modifier={modifier}
        {...arriving}
      >
        <Handle
          type="source"
          id="note-out"
          position={Position.Right}
          isConnectable={false}
          className="note-handle"
        />
        <Handle
          type="source"
          id="aux-out"
          position={Position.Left}
          isConnectable={false}
          className="note-handle"
        />
        {axis === 'vertical' && (
          <>
            <Handle
              type="target"
              id="step-in"
              position={Position.Top}
              isConnectable={false}
              className="note-handle"
              {...(spineStyle ? { style: spineStyle } : {})}
            />
            <Handle
              type="source"
              id="step-out"
              position={Position.Bottom}
              isConnectable={false}
              className="note-handle"
              {...(spineStyle ? { style: spineStyle } : {})}
            />
          </>
        )}
        {flow && data.onAddAfter && (
          <button
            type="button"
            className="step-add nodrag"
            style={{ left: spineX }}
            aria-label={`Añadir un paso después de la etapa ${stage.title}`}
            title="Añadir un paso al final de esta etapa"
            onClick={(event) => {
              event.stopPropagation()
              data.onAddAfter?.(id, { x: event.clientX, y: event.clientY })
            }}
          >
            <Icon name="plus" size={12} />
          </button>
        )}
        {data.drop && (
          <div className="drop-hint" data-drop={data.drop} aria-hidden>
            <span className="drop-hint__label type-badge">
              {data.drop === 'into'
                ? `Suelta para meterlo en «${stage.title}»`
                : `Suelta fuera para sacarlo de «${stage.title}»`}
            </span>
          </div>
        )}
        {container ? (
          <SectionFrame
            info={stage}
            role={data.role}
            note={node.note}
            size={size}
            signal={data.renameSignal ?? 0}
            onToggle={toggle}
            onRetitle={retitle}
          />
        ) : (
          <SectionCard
            info={stage}
            role={data.role}
            usedBy={data.usedBy}
            note={node.note}
            size={size}
            signal={data.renameSignal ?? 0}
            onToggle={toggle}
            onOpen={data.onOpen}
            onRetitle={retitle}
          />
        )}
      </div>
    )
  }

  return (
    <div
      className="flow-node"
      data-phase={phase}
      data-selected={selected ? '' : undefined}
      data-add-target={data.addTarget ? '' : undefined}
      data-cursor={data.cursor ? '' : undefined}
      data-spotlit={data.spotlit === undefined ? undefined : data.spotlit % 2}
      data-born={data.born ? '' : undefined}
      data-echo={data.echoed ? '' : undefined}
      data-change={data.change}
      data-hinted={data.hinted ? '' : undefined}
      {...(opened ? { 'data-opened': '', style: opened } : arriving)}
    >
      {from && opened && node.gist && (
        // La tarjeta de la que sale el diagrama: se queda un momento encima, deshaciéndose, mientras el
        // marco crece y los nodos aparecen debajo. Es un fundido: no se puede tocar ni leer.
        <div
          className="gist-ghost"
          aria-hidden
          inert
          style={{ width: from.w, height: from.h, marginLeft: -from.w / 2 }}
        >
          <GistCard scene={{ ...node.gist, beats: 0 }} size={{ w: from.w, h: from.h }} />
        </div>
      )}
      {/* De aquí sale la flecha de una nota: existe en todo nodo (también en un territorio, que no tiene salida). */}
      <Handle
        type="source"
        id="note-out"
        position={Position.Right}
        isConnectable={false}
        className="note-handle"
      />
      {/* Y de aquí el cable hacia un visor a la izquierda. */}
      <Handle
        type="source"
        id="aux-out"
        position={Position.Left}
        isConnectable={false}
        className="note-handle"
      />
      {/* La espina de la secuencia, leída hacia abajo: entra por el centro de arriba y sale por el de abajo. */}
      {axis === 'vertical' && (
        <>
          <Handle
            type="target"
            id="step-in"
            position={Position.Top}
            isConnectable={false}
            className="note-handle"
            {...(spineStyle ? { style: spineStyle } : {})}
          />
          <Handle
            type="source"
            id="step-out"
            position={Position.Bottom}
            isConnectable={false}
            className="note-handle"
            {...(spineStyle ? { style: spineStyle } : {})}
          />
          {/* Un salto (`break`, `continue`) sale por la derecha: rodea lo que queda debajo. */}
          {(node.kind === 'control.break' || node.kind === 'control.continue') && (
            <Handle
              type="source"
              id="step-side"
              position={Position.Right}
              isConnectable={false}
              className="note-handle"
            />
          )}
          {/* El camino «no» de una decisión sale por el vértice derecho del rombo. */}
          {diamond && (
            <Handle
              type="source"
              id="step-no"
              position={Position.Right}
              isConnectable={false}
              className="note-handle"
              style={{ left: gate.x + GATEWAY.size / 2, right: 'auto', top: gate.y }}
            />
          )}
        </>
      )}
      {axis === 'vertical' && node.line !== undefined && (
        <span className="flow-step" aria-hidden title={`Línea ${node.line}`}>
          {node.line}
        </span>
      )}
      {/* Añadir el paso siguiente: un «+» sobre la espina, justo debajo (tras un salto no sigue nada). */}
      {flow && data.onAddAfter && !diamond && !JUMP_KINDS.has(node.kind) && (
        <button
          type="button"
          className="step-add nodrag"
          style={{ left: spineX }}
          aria-label={`Añadir un paso después de ${node.label}`}
          title="Añadir un paso aquí"
          onClick={(event) => {
            event.stopPropagation()
            data.onAddAfter?.(id, { x: event.clientX, y: event.clientY })
          }}
        >
          <Icon name="plus" size={12} />
        </button>
      )}
      {/* La bifurcación: un tramo de espina bajo la pregunta y el rombo donde se parte el camino. */}
      {diamond && (
        <svg
          className="gateway"
          width={size.w}
          height={GATEWAY.gap + GATEWAY.size}
          style={{ top: cardSize.h }}
          aria-hidden
        >
          <path className="gateway__stub" d={`M ${gate.x} 0 V ${GATEWAY.gap}`} />
          <path
            className="gateway__shape"
            transform={`translate(${gate.x - GATEWAY.size / 2} ${GATEWAY.gap})`}
            d={buildShape('diamond', GATEWAY.size, GATEWAY.size).d}
          />
        </svg>
      )}
      {container && node.laps && (
        <div
          className="laps-slot"
          style={{ left: insetLeft, right: insetLeft, top: headTop - LAPS_HEADROOM }}
        >
          <LapsStrip laps={node.laps} exclude={node.params ?? []} label={node.label} />
        </div>
      )}
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

      {/* Lo que devuelve la función: una pastilla en el borde (o un hueco donde soltar un chip), o un cable si no tiene nombre. */}
      {takesReturn && (returnChip || (connectable && data.chipDragging)) && (
        <div
          className="return-slot"
          data-side={horizontal ? 'right' : 'bottom'}
          style={along(horizontal ? geo.handles.out.y : geo.handles.out.x)}
        >
          <span className="return-slot__label type-badge">devuelve</span>
          <span
            className="input return-slot__pill"
            data-slot="return"
            data-slot-label="Devuelve"
            data-chip={
              returnChip
                ? returnChip.iter
                  ? 'iter'
                  : returnChip.param
                    ? 'param'
                    : returnChip.type
                : undefined
            }
            data-hot={data.hotSlot?.slot === 'return' ? (data.hotSlot.ok ? 'ok' : 'no') : undefined}
            title={
              returnChip
                ? `${returnChip.name}: lo que devuelve la función`
                : 'Suelta aquí lo que devuelve'
            }
          >
            {returnChip?.name ?? ''}
            {returnChip && data.onClearChip && (
              <button
                type="button"
                className="chip-clear nodrag"
                aria-label={`Quitar ${returnChip.name} de lo que devuelve`}
                onClick={(event) => {
                  event.stopPropagation()
                  data.onClearChip?.(id, 'return')
                }}
              >
                <Icon name="x" size={11} />
              </button>
            )}
          </span>
        </div>
      )}
      {returnCable && (
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
            // Leído hacia abajo, un `break` sin nada detrás del bucle sale por su derecha, hacia abajo.
            style={flow ? { left: size.w + FLOW_LANE, top: size.h + 18 } : along(middle)}
            {...(flow ? { className: 'note-handle' } : {})}
            title="Por aquí sale el flujo cuando el bucle termina"
            isConnectable={false}
            data-type="any"
            data-open={linkedSlots.includes('exit') ? undefined : ''}
          />
          {/* En el diagrama de flujo, el `break` ya sale hasta el paso que sigue al bucle. */}
          {horizontal && (
            <span
              className="port-label type-badge"
              data-side="right"
              style={along(middle)}
              aria-hidden
            >
              termina
            </span>
          )}
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
            {...(flow ? { className: 'note-handle' } : {})}
          />
          {/* En el diagrama de flujo, un `continue` llega al carril de vuelta: no hace falta el puerto. */}
          {horizontal && (
            <span
              className="port-label type-badge"
              data-side="inside"
              data-rail=""
              style={along(Math.max(20, contentTop - 10))}
              aria-hidden
            >
              siguiente
            </span>
          )}
        </>
      )}
      {gives &&
        !takesReturn &&
        !isLoop &&
        // En un diagrama de flujo solo salen de un paso sus saltos (`break`, `continue`): no hay datos.
        (!flow || node.kind === 'control.break' || node.kind === 'control.continue') && (
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
      {!flow && spec.ports.out && geo.handles.alt && (
        <Handle
          type="source"
          id="alt"
          position={sourceSide}
          style={along(horizontal ? geo.handles.alt.y : geo.handles.alt.x)}
          isConnectable={false}
        />
      )}

      {/* Leído hacia abajo, el carril vuelve por la izquierda y entra de nuevo arriba del cuerpo. */}
      {isLoop && !horizontal && (
        <>
          {/* Aquí, al pie del cuerpo y en la espina, llega todo lo que vuelve a empezar. */}
          <Handle
            type="target"
            id="rail-in"
            position={Position.Top}
            isConnectable={false}
            className="note-handle"
            style={{ top: size.h - FLOW_RAIL, left: spineX }}
          />
          <svg className="loop-rail" data-flow="" width={size.w} height={size.h} aria-hidden>
            <path
              className="loop-rail__line"
              d={flowRailPath(spineX, size.h, contentTop)}
              fill="none"
            />
            <path
              className="loop-rail__head"
              d={`M ${spineX - 4.5} ${contentTop - 8} L ${spineX} ${contentTop - 2} L ${spineX + 4.5} ${contentTop - 8}`}
              fill="none"
            />
          </svg>
          <span
            className="loop-rail__label type-badge"
            data-flow=""
            style={{ top: Math.round((contentTop + size.h) / 2) }}
          >
            <Icon name="repeat" size={11} />
            repite
          </span>
        </>
      )}
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

      {/*
        Los puertos de orden: aparecen al pasar el ratón o al seleccionar el nodo. Arrastrar de la salida de uno
        a otro nodo lo coloca justo detrás; de los de una decisión, al principio de su camino verdadero o del
        else; del de inicio de una función o un bucle, al principio de lo que actúa.
      */}
      {connectable && !isCompactCard && (
        <>
          <Handle
            type="target"
            id="order-in"
            position={orderIn}
            className="order-port"
            title="Aquí se ejecuta: suelta un cable de orden para poner este nodo detrás de otro"
            isConnectable
          />
          {node.kind === 'control.condition' ? (
            <>
              <Handle
                type="source"
                id="order-yes"
                // En el rombo, cada puerto en su vértice: el «sí» abajo y el «no» a la derecha.
                position={diamond ? Position.Bottom : orderOut}
                className="order-port"
                data-branch="yes"
                style={diamond ? { left: '50%', bottom: -14 } : acrossEdge(25)}
                title="Al principio del camino verdadero"
                isConnectable
              />
              {/* Si su camino falso sigue en un `elif`, se entra por los puertos de ese `elif`. */}
              {node.continues === undefined && (
                <Handle
                  type="source"
                  id="order-no"
                  position={orderOut}
                  className="order-port"
                  data-branch="no"
                  style={
                    diamond
                      ? { left: gate.x + GATEWAY.size / 2 + 12, right: 'auto', top: gate.y }
                      : acrossEdge(75)
                  }
                  title="Al principio del camino falso (else)"
                  isConnectable
                />
              )}
            </>
          ) : node.kind === 'control.loop' ? (
            // El `else` de un bucle: lo que se hace una vez, al acabar sin salir con `break`.
            <Handle
              type="source"
              id="order-no"
              position={orderOut}
              className="order-port"
              data-branch="no"
              style={acrossEdge(75)}
              title="Al acabar sin salir (else del bucle): se crea si no lo tiene"
              isConnectable
            />
          ) : null}
          <Handle
            type="source"
            id="order-out"
            position={orderOut}
            className="order-port"
            title="Lo que sigue: arrastra a un nodo para ponerlo detrás de este"
            isConnectable
          />
          {container && (
            <Handle
              type="source"
              id="order-body"
              position={Position.Left}
              className="order-port"
              data-body=""
              style={{ top: contentTop + 12 }}
              title="Al principio de lo que hace: arrastra a un nodo para ponerlo primero"
              isConnectable
            />
          )}
        </>
      )}

      <MorphNode
        kind={node.kind}
        label={node.label}
        {...(stage ? { ordinal: stage.ordinal } : {})}
        {...(node.subprocesses && node.subprocesses.length > 0
          ? { opens: node.subprocesses, ...(data.onOpen ? { onOpen: data.onOpen } : {}) }
          : {})}
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
        size={cardSize}
        state={state}
        {...(modifier ? { modifier } : {})}
        container={container}
        {...(diamond ? { question: true } : {})}
        flow={flow}
        renameSignal={data.renameSignal ?? 0}
        showStatus={data.showStatus}
        // Los puertos los dibuja React Flow a partir de los Handle: aquí solo se miden.
        showPorts={false}
        focused={selected}
        linkedSlots={linkedSlots}
        {...(data.chipSlots ? { chipSlots: data.chipSlots } : {})}
        {...(data.line ? { line: true } : {})}
        {...(node.steps ? { steps: node.steps } : {})}
        {...(results.length > 0
          ? {
              results: results.map((name) => ({
                name,
                type: node.valueType ?? 'any',
                ...(node.observed?.[name]?.short ? { hint: node.observed[name].short } : {}),
                ...(node.observed?.[name] ? { title: node.observed[name].long } : {}),
                // Reproduciendo una lección: este paso lo acaba de escribir, y el chip lo anuncia.
                ...(node.observed?.[name]?.changed ? { changed: true } : {}),
              })),
              ...(data.onGrabResult
                ? {
                    onGrabResult: (event: React.PointerEvent<HTMLElement>, name: string) => {
                      data.onGrabResult?.(id, event, name)
                    },
                  }
                : {}),
            }
          : {})}
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
        // Una llamada con pastillas ya lleva a su función desde ellas: el chevron repetiría lo mismo.
        {...(node.openable && data.onEnter && !(node.opens && node.subprocesses?.length)
          ? {
              onToggleDensity: () => data.onEnter?.(id),
              // Una llamada lleva a la función que llama; una función, a plegarse o abrirse.
              ...(node.opens
                ? { toggleLabel: `Ver la función de ${node.label}` }
                : container
                  ? {}
                  : node.kind === 'control.condition'
                    ? { toggleLabel: 'Ver cómo funciona' }
                    : { toggleLabel: `Abrir ${node.label}` }),
            }
          : {})}
      />
    </div>
  )
}
