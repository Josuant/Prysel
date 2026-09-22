import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type NodeChange,
} from '@xyflow/react'
import {
  extraHeight,
  isLineCard,
  lineHeight,
  lineWidth,
  slimHeight,
  slimWidth,
  getKind,
  nodeSize,
  type Density,
  type Metrics,
  type NodeAction,
  type NodeKindId,
  type NodeState,
  type ValueType,
} from '@prysel/morphology'
import {
  SCOPE_FRAME,
  channelOf,
  layout,
  type Axis,
  type SemanticEdge,
  type SemanticGraph,
} from '@prysel/spatial'
import { EdgeDefs } from './Edge.tsx'
import { NoteNode, type NoteFlowNode } from './flow/NoteNode.tsx'
import { NOTE, NOTE_GUTTER, noteSize, placeNotes, type NoteContent, type NoteSlot } from './note.ts'
import { PryselNode, type PryselFlowNode } from './flow/PryselNode.tsx'
import { PryselEdge, type PryselFlowEdge } from './flow/PryselEdge.tsx'
import { dragTerritory, territoryAt } from './drag.ts'
import { isTerritory, nodeFrame, territoryHeadroom } from './flow/frame.ts'
import { useMotion } from './motion.ts'
import type { ControlModel } from './controls.tsx'
import { CodePanel } from './CodePanel.tsx'
import { QuickAdd } from './QuickAdd.tsx'
import { NodeMenu, type NodeMenuItem } from './NodeMenu.tsx'
import { ChipNode, TrayNode, type ChipFlowNode, type TrayFlowNode } from './flow/ChipNode.tsx'
import { ViewerNode, type ViewerFlowNode } from './flow/ViewerNode.tsx'
import { viewerSize, type ViewerContent } from './viewer.ts'
import type { LapsView } from './laps.ts'
import { runFor } from './fit.ts'
import type { StepInfo } from './steps.ts'
import { FUNCTION_CHIP, chipSource, useChipDrag } from './flow/useChipDrag.ts'
import {
  MODULE,
  TRAY,
  chipSize,
  functionChipSize,
  isChipKind,
  iterChipSize,
  iterName,
  parseIterChip,
  planChips,
  promoteTarget,
  resultChipId,
  resultNames,
  type FunctionChip,
} from './chips.ts'
import {
  ORDER_IN,
  checkConnection,
  checkOrder,
  isOrderHandle,
  orderPlace,
  type OrderPort,
  connectAction,
  convertNotice,
  dropTarget,
  outputName,
  type Link,
} from './connect.ts'
import type { NodeEdit } from './MorphNode.tsx'
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
  /** Es una llamada a una función que el programa define: el id de esa definición. */
  opens?: string
  /** Lo que el código dice de sí mismo: sus comentarios y, en una función, su documentación. */
  note?: string
  /**
   * Qué campos del editor se pueden escribir de vuelta en el código, por su camino. Sin lista, todos
   * (un nodo de ejemplo, sin código detrás); con lista vacía, ninguno.
   */
  editable?: readonly string[]
  /** El texto tal como está en el archivo (la sentencia, o su cabecera si es compuesta): lo que se edita como código. */
  text?: string
  /** El título es un nombre que Python conoce: se puede renombrar (y cambia en todos sus usos). */
  renamable?: boolean
  /** Su línea en el archivo. */
  line?: number
  /** Los nombres que se pueden usar en sus campos (las variables definidas antes): son las sugerencias. */
  scope?: readonly string[]
  /** El nombre que el nodo deja definido: lo que sale por su puerto de salida, si sale algo. */
  provides?: string
  /** Los nombres que deja definidos una asignación de varios valores (`a, b = f()`): cada uno, un chip. */
  results?: readonly string[]
  /** Lo que se observó de cada paso de una cadena (índice 0: el receptor). */
  steps?: readonly StepInfo[]
  /** Un bucle que ya dio vueltas: lo que valió cada nombre en cada una, para recorrerlas en su cabecera. */
  laps?: LapsView
  /** Es un visor: enseña el valor que otro nodo dejó al ejecutarse. No es una sentencia del programa. */
  viewer?: ViewerContent
  /** Es una nota: un rótulo a mano que explica lo que tiene al lado. No es una sentencia del programa. */
  handwritten?: NoteContent
  /**
   * Lo que se observó al ejecutar, por nombre: `short` es lo que acompaña a su chip (`200×2`) y `long` lo
   * que dice al pasar el puntero (`ndarray 200×2 float64`). Nunca cambia lo que significa el código.
   */
  observed?: Readonly<Record<string, { short?: string; long: string }>>
  /** En una función, sus parámetros: cada uno es un puerto de salida hacia lo que hay dentro. */
  params?: readonly string[]
  /** Los campos que aceptan un cable (por su puerto). */
  inputs?: readonly string[]
  /** La sentencia que lo envuelve (una función, un bucle, una decisión); sin ella, es del programa. */
  owner?: string
  /** Qué clase de valor sale del nodo: colorea su puerto y decide adónde se puede conectar. */
  valueType?: ValueType
  /** Es un `return` de esta función: su salida va al puerto de retorno de la función. */
  returns?: string
}

export interface CanvasProps {
  nodes: CanvasNode[]
  edges: SemanticEdge[]
  density: Density
  stateOf?: (id: string) => NodeState
  onControlChange?: (id: string, next: ControlModel) => void
  /** Lo que el usuario le hace a un nodo: reescribirlo como código, eliminarlo, duplicarlo, renombrarlo. */
  onAction?: (action: NodeAction) => void
  /** La función (o el bucle) donde irá lo que se añada, para marcarla: es donde va a caer, no un misterio. */
  addTarget?: string | null
  /** Las funciones del programa: se ofrecen como chips que se arrastran a una llamada. */
  palette?: readonly FunctionChip[]
  /** La cajita del programa admite añadir variables (no cuando se ve una sola función). */
  addToModule?: boolean
  /** El nodo seleccionado, si lo lleva quien usa el lienzo (para poder enfocar lo que acaba de crear). */
  selected?: string | null
  onSelect?: (id: string | null) => void
  /** Ejecutar un nodo (con lo que necesita): si el lienzo tiene un motor detrás, el menú lo ofrece. */
  onRun?: (id: string) => void
  /** Más entradas para el menú de un nodo (por ejemplo, fijar su valor en un visor). */
  extraMenu?: (id: string) => NodeMenuItem[]
  /** Quitar un visor del lienzo. */
  onUnpin?: (id: string) => void
  onEnter?: (id: string) => void
  /** Eje de lectura del programa. */
  axis?: Axis
  gapX?: number
  gapY?: number
  /**
   * Altura del lienzo. Sin ella, la que necesite el programa (hasta un máximo razonable).
   * `fill` ocupa todo el alto de su contenedor: es lo que quiere una vista a pantalla completa.
   */
  height?: number | 'fill'
  /** Altura mínima, para que una rejilla de ejemplos no quede dentada. */
  minHeight?: number
  /**
   * Permite recorrer, acercar, seleccionar y arrastrar. Desactivado, el lienzo es una
   * ilustración: útil para los ejemplos pequeños, donde poder moverlos solo sería ruido.
   */
  interactive?: boolean
  /** Habilita el menú de cada nodo (clic derecho): duplicar, editar como código, eliminar… */
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
  /**
   * Identifica «qué se está viendo». Al cambiar (se entra en otra función), el lienzo olvida lo
   * que el usuario movió, seleccionó o recorrió y vuelve a encuadrar: es otro diagrama.
   */
  fitKey?: string
  /**
   * El nodo por el que va la reproducción de una traza: se marca con un anillo y, si se sale de la vista,
   * la cámara lo sigue. Sin él, no hay reproducción.
   */
  cursor?: string | null
  /** Etiqueta accesible del lienzo, leída por lectores de pantalla. */
  ariaLabel?: string
  className?: string
}

/** La identidad de un cable, con la que se selecciona. */
const edgeKey = (edge: SemanticEdge) =>
  `${edge.from}${edge.fromPort ? `:${edge.fromPort}` : ''}-${edge.to}-${edge.toPort ?? ''}-${edge.relation}`

const NODE_TYPES = {
  prysel: PryselNode,
  chip: ChipNode,
  tray: TrayNode,
  viewer: ViewerNode,
  note: NoteNode,
}

/** Todo lo que el lienzo dibuja: nodos, chips y la cajita del programa. */
type AnyFlowNode = PryselFlowNode | ChipFlowNode | TrayFlowNode | ViewerFlowNode | NoteFlowNode

/** Funciones de uso común que se ofrecen al elegir a quién llama una llamada. */
const COMMON_CALLS = [
  'print',
  'input',
  'len',
  'range',
  'int',
  'float',
  'str',
  'bool',
  'list',
  'dict',
  'sum',
  'min',
  'max',
  'abs',
  'round',
  'sorted',
]

/** Dónde empieza la cajita del programa. */
const MODULE_TRAY_AT = { x: 28, y: 28 }
const EDGE_TYPES = { prysel: PryselEdge }
/** Alto máximo por defecto: a partir de aquí, el lienzo se recorre en vez de crecer. */
const MAX_HEIGHT = 640
/** Lo más que la cámara se aleja para que quepan a la vez el cursor y la nota que se lee. */
const MIN_FOLLOW_ZOOM = 0.45

type Point = { x: number; y: number }
const NO_POSITIONS: Record<string, Point> = {}
const NO_SIZES: Record<string, { w: number; h: number }> = {}

export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function CanvasInner({
  nodes: allNodes,
  edges: allEdges,
  density,
  stateOf,
  onControlChange,
  onAction,
  addTarget,
  palette,
  addToModule = true,
  selected: selectedProp,
  onSelect,
  onEnter,
  axis = 'horizontal',
  gapX,
  gapY,
  height,
  minHeight = 0,
  interactive = false,
  showActions = true,
  onRun,
  extraMenu,
  onUnpin,
  showStatus = true,
  animate = true,
  fitMode,
  fitKey = '',
  cursor = null,
  ariaLabel,
  className,
}: CanvasProps) {
  // Lo que el usuario hace sobre el diagrama (mover, seleccionar, recorrer) pertenece a «lo que
  // se está viendo»: al cambiar `fitKey` se descarta, sin efectos, porque se compara la clave.
  /** Posiciones que el usuario ha movido a mano: mandan sobre las que propone la gramática. */
  const [movedState, setMovedState] = useState({ key: fitKey, positions: NO_POSITIONS })
  const moved = movedState.key === fitKey ? movedState.positions : NO_POSITIONS
  /** El lienzo se reencuadra solo hasta que el usuario lo recorre: a partir de ahí, manda él. */
  const [takenKey, setTakenKey] = useState<string | null>(null)
  const taken = takenKey === fitKey
  const [selectedState, setSelectedState] = useState<{ key: string; id: string } | null>(null)
  // La selección la puede llevar quien usa el lienzo (para enfocar lo que acaba de crear); si no, la lleva él.
  const selectedId =
    selectedProp !== undefined
      ? selectedProp
      : selectedState?.key === fitKey
        ? selectedState.id
        : null
  /** El cable seleccionado (para desconectarlo), si es de los que se pueden soltar. */
  const [edgeState, setEdgeState] = useState<{ key: string; id: string } | null>(null)
  const edgeId = edgeState?.key === fitKey ? edgeState.id : null
  const select = useCallback(
    (id: string | null) => {
      setSelectedState(id === null ? null : { key: fitKey, id })
      setEdgeState(null)
      onSelect?.(id)
    },
    [fitKey, onSelect],
  )
  /** El nodo que se está editando como código, mientras el panel está abierto. */
  const [codeFor, setCodeFor] = useState<{ key: string; id: string } | null>(null)
  /** De dónde sale el cable que se está arrastrando ahora mismo. */
  const [connecting, setConnecting] = useState<{ from: string; port?: string } | null>(null)
  /** Se soltó un cable de orden en el vacío: aquí se ofrece crear una sentencia nueva. */
  const [orderAdd, setOrderAdd] = useState<{
    from: string
    port: OrderPort
    x: number
    y: number
  } | null>(null)
  /** Se arrastra un cable de orden desde este nodo y este puerto. */
  const [ordering, setOrdering] = useState<{ from: string; port: OrderPort } | null>(null)
  /** El menú de «crear un nodo ya conectado», abierto donde se soltó el cable en el vacío. */
  const [quick, setQuick] = useState<{ x: number; y: number; from: string; port?: string } | null>(
    null,
  )
  /** El menú de un nodo, abierto donde se hizo clic derecho. */
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  /** Un nodo al que el menú le ha pedido renombrarse: el contador abre su cuadro cada vez. */
  const [renaming, setRenaming] = useState<{ id: string; n: number }>({ id: '', n: 0 })
  /** Por qué no se pudo conectar: un aviso breve, para que el rechazo no parezca un fallo. */
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => {
      setNotice(null)
    }, 3600)
    return () => {
      clearTimeout(timer)
    }
  }, [notice])
  /** Se puede conectar arrastrando: hay un lienzo con el que interactuar y dónde escribir el resultado. */
  const connectable = interactive && onAction !== undefined
  /** Mientras se arrastra, el nodo sigue al puntero: interpolar su posición lo haría ir por detrás. */
  const [dragging, setDragging] = useState(false)
  /** Un nodo arrastrado a otra función (o fuera de la suya): a dónde iría al soltarlo, y de dónde sale. */
  const [reparent, setReparent] = useState<{
    id: string
    to: string | null
    from: string | null
  } | null>(null)
  /** Lo que el usuario ha ensanchado a mano (las funciones): mandan sobre el tamaño que propone la gramática. */
  const [resizedState, setResizedState] = useState<{
    key: string
    sizes: Record<string, { w: number; h: number }>
  }>({ key: fitKey, sizes: {} })
  const resized = resizedState.key === fitKey ? resizedState.sizes : NO_SIZES

  const { setViewport, getViewport, setCenter } = useReactFlow()
  /**
   * Cuánto mide de largo una fila del diagrama según el ancho del lienzo: en un panel estrecho se pliega
   * antes, para que el programa se lea a un zoom legible y crezca en alto (ver `fit.ts`).
   */
  const [run, setRun] = useState<number | undefined>(undefined)
  const frameRef = useRef<HTMLDivElement>(null)
  const lastFit = useRef('')
  /** Dónde está cada nodo ahora mismo: lo necesita un arrastre para saber cuánto se ha movido. */
  const shownRef = useRef<Record<string, Point>>({})
  const boxesRef = useRef<Record<string, { x: number; y: number; w: number; h: number }>>({})

  const densityOf = useCallback(
    (node: CanvasNode): Density => (density === 'normal' ? (node.density ?? 'normal') : density),
    [density],
  )

  // Las notas no entran en el reparto del diagrama: van en un margen aparte, y aparecer o desaparecer una
  // nota nunca mueve nada de lo que ya estaba.
  const nodes = useMemo(() => allNodes.filter((node) => !node.handwritten), [allNodes])
  const noteNodes = useMemo(() => allNodes.filter((node) => node.handwritten), [allNodes])
  const noteIds = useMemo(() => new Set(noteNodes.map((node) => node.id)), [noteNodes])
  const edges = useMemo(() => allEdges.filter((edge) => !noteIds.has(edge.to)), [allEdges, noteIds])
  const noteLinks = useMemo(
    () => allEdges.filter((edge) => noteIds.has(edge.to)),
    [allEdges, noteIds],
  )

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])

  /** El reparto en chips: qué va en cada cajita, qué se coloca en el plano y qué casillas llevan uno. */
  const plan = useMemo(
    () =>
      planChips(nodes, edges, {
        canAdd: connectable,
        density: densityOf,
        ...(palette ? { palette } : {}),
        addToModule,
      }),
    [nodes, edges, connectable, palette, addToModule, densityOf],
  )

  /** De todo lo que puede dar un valor: los nodos, y las funciones que se ofrecen como chips. */
  const lookup = useMemo(() => {
    const all = new Map(byId)
    for (const fn of palette ?? []) {
      if (all.has(fn.id)) continue
      all.set(fn.id, {
        id: fn.id,
        kind: 'abstraction.collapsed',
        label: fn.name,
        provides: fn.name,
        params: [...fn.params],
      })
    }
    return all
  }, [byId, palette])

  /** ¿Es un chip acoplado a una cajita (o el de una función)? Esos no se colocan: se llevan a una casilla. */
  const isDockedChip = useCallback(
    (id: string) => {
      const node = byId.get(id)
      return (
        plan.docked.has(id) ||
        id.startsWith(FUNCTION_CHIP) ||
        parseIterChip(id) !== null ||
        // Un valor asignado a mitad de flujo también es un chip: se lleva a una casilla, no se coloca.
        (node !== undefined && isChipKind(node))
      )
    },
    [plan, byId],
  )

  const chipDrag = useChipDrag({
    lookup,
    onLink: (link) => {
      onAction?.(connectAction(link))
    },
    onRefuse: setNotice,
    onEmpty: (chipId, point) => {
      // Soltar un chip en el vacío ofrece crear un nodo que lo use, como antes lo hacía soltar un cable.
      const source = chipSource(chipId)
      const frame = frameRef.current?.getBoundingClientRect()
      if (!frame || !byId.has(source.from)) return
      setQuick({
        from: source.from,
        ...(source.port ? { port: source.port } : {}),
        x: point.clientX - frame.left,
        y: point.clientY - frame.top,
      })
    },
  })

  /**
   * El chip del resultado de una línea (`A = funcion()`) vive dentro de su tarjeta, no es un nodo del
   * lienzo: al agarrarlo se lleva una copia (el «fantasma») hasta una casilla, con la misma
   * validación que cualquier chip, y al soltarlo vuelve a su sitio.
   */
  const [ghost, setGhost] = useState<{
    name: string
    type: ValueType
    x: number
    y: number
  } | null>(null)
  const chipDragRef = useRef(chipDrag)
  useEffect(() => {
    chipDragRef.current = chipDrag
  })
  const grabResult = useCallback(
    (id: string, event: React.PointerEvent<HTMLElement>, name?: string) => {
      if (event.button !== 0) return
      const source = byId.get(id)
      if (!source) return
      // Un resultado entre varios (`a, b = f()`) es un chip propio: sale por su puerto.
      const chip = name !== undefined && source.provides === undefined ? resultChipId(id, name) : id
      const from = { x: event.clientX, y: event.clientY }
      let moved = false
      const move = (e: PointerEvent) => {
        if (!moved && Math.hypot(e.clientX - from.x, e.clientY - from.y) < 5) return
        moved = true
        const frame = frameRef.current?.getBoundingClientRect()
        if (frame) {
          setGhost({
            name: name ?? source.provides ?? source.label,
            type: source.valueType ?? 'any',
            x: e.clientX - frame.left,
            y: e.clientY - frame.top,
          })
        }
        chipDragRef.current.over(chip, e)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        if (!moved) return
        setGhost(null)
        chipDragRef.current.drop(chip)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [byId],
  )

  /**
   * Qué campos de cada nodo reciben una conexión: lo dice el grafo, no la interfaz.
   * Se calcula antes del layout porque el alto de un nodo depende de cuántos campos enseña,
   * y la conexión de una función a su propio cuerpo (sus parámetros) no se dibuja: no cuenta.
   */
  const linked = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const edge of edges) {
      if (!edge.toPort) continue
      const from = byId.get(edge.from)
      // Un parámetro sí llega a un campo de dentro: es un cable de verdad, con su puerto.
      const isBody =
        from !== undefined &&
        !edge.fromPort?.startsWith('param:') &&
        getKind(from.kind).role === 'abstraction' &&
        from.contains?.includes(edge.to)
      if (isBody) continue
      map[edge.to] = [...(map[edge.to] ?? []), edge.toPort]
    }
    return map
  }, [edges, byId])

  const {
    placements,
    bounds: layoutBounds,
    scopes,
  } = useMemo(() => {
    const graph: SemanticGraph = {
      nodes: plan.flowNodes.map((node) => {
        const spec = getKind(node.kind)
        const d = densityOf(node)
        const base = nodeSize(spec, d, node.metrics)
        const tray = plan.trays.get(node.id)
        const head = territoryHeadroom(node) + (tray ? tray.h + TRAY.below : 0)
        return {
          id: node.id,
          role: spec.role,
          // El editor manda sobre el alto: si no cabe, el campo se recorta y su puerto cae fuera.
          // Un valor suelto (que no cabe en ninguna cajita) es una píldora, no una tarjeta.
          size: node.viewer
            ? viewerSize(node.viewer)
            : isChipKind(node)
              ? chipSize(node)
              : d === 'normal' && isLineCard(node.kind, node.control)
                ? // Una operación o una llamada: una sola línea, con su nombre como chip.
                  {
                    w: lineWidth(
                      node.control,
                      // Cada pastilla mide también lo que se observó de su valor (`200×2`).
                      resultNames(node, d).map((name) => {
                        const short = node.observed?.[name]?.short
                        return short ? `${name} ${short}` : name
                      }),
                      linked[node.id],
                      node.openable ? 26 : 0,
                    ),
                    h: lineHeight(node.note),
                  }
                : d === 'normal'
                  ? // La tarjeta esbelta mide lo que lleva dentro, ni más ni menos.
                    {
                      w: slimWidth(base.w, node.control),
                      h: slimHeight(
                        node.control,
                        linked[node.id],
                        node.note,
                        node.code !== undefined,
                      ),
                    }
                  : {
                      w: base.w,
                      h: base.h + extraHeight(node.control, d, linked[node.id], node.note),
                    },
          // La documentación, el editor de un bucle y la cajita de chips viven en la cabecera de un territorio.
          ...(head > 0 ? { headroom: head } : {}),
          ...(tray ? { headerWidth: tray.w } : {}),
          // Un bucle con cuerpo envuelve lo que repite, igual que una función.
          ...(isTerritory(node) ? { territory: true } : {}),
          ...(node.contains && resized[node.id] ? { minSize: resized[node.id] } : {}),
          ...(node.contains ? { contains: node.contains } : {}),
        }
      }),
      edges: plan.flowEdges,
    }
    return layout(graph, {
      axis,
      ...(gapX === undefined ? {} : { gapX }),
      ...(gapY === undefined ? {} : { gapY }),
      ...(run === undefined ? {} : { maxRun: run }),
    })
  }, [plan, densityOf, axis, gapX, gapY, linked, resized, run])

  /**
   * La procedencia a demanda: al seleccionar un nodo se dibujan sus cables ocultos (de dónde le llegan
   * los valores y a quién los da). Solo entre nodos que tienen puertos; un chip de una cajita o de un
   * bucle no los tiene, y a esos se les marcan las casillas.
   */
  const revealed = useMemo(() => {
    const shown = new Set<SemanticEdge>()
    if (selectedId === null) return shown
    for (const edge of [...plan.hidden, ...plan.order]) {
      if (edge.from !== selectedId && edge.to !== selectedId) continue
      const from = byId.get(edge.from)
      const to = byId.get(edge.to)
      if (!from || !to || isChipKind(from) || isChipKind(to)) continue
      if (plan.docked.has(edge.from) || iterName(plan.iterVars, edge) !== undefined) continue
      shown.add(edge)
    }
    // Entre dos nodos consecutivos que ya se unen por un dato, el orden iría por el mismo camino: no se repite.
    const linked = new Set(
      [...shown].filter((edge) => edge.relation !== 'sequence').map((e) => `${e.from}|${e.to}`),
    )
    for (const edge of shown) {
      if (edge.relation === 'sequence' && linked.has(`${edge.from}|${edge.to}`)) shown.delete(edge)
    }
    return shown
  }, [selectedId, plan, byId])

  /** Las casillas que solo reciben chips y no llevan puerto, salvo las que ahora enseñan su cable. */
  const chipOnly = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const [id, slots] of Object.entries(plan.chipOnly)) {
      const open = new Set<string>()
      for (const edge of revealed) if (edge.to === id && edge.toPort) open.add(edge.toPort)
      map[id] = open.size === 0 ? slots : slots.filter((slot) => !open.has(slot))
    }
    return map
  }, [plan, revealed])

  // Lo que un ámbito envuelve ya lo dice el espacio: la conexión de la función a su propio
  // cuerpo (sus parámetros) sería una línea redundante que cruza su cabecera.
  const visibleEdges = useMemo(
    () =>
      // El orden de ejecución no se dibuja: en un bloque lineal ya lo dice la posición. Solo se ve, junto
      // con los cables ocultos, al seleccionar un nodo.
      [...edges.filter((edge) => edge.relation !== 'sequence'), ...plan.order].filter((edge) => {
        if (edge.relation === 'sequence') return revealed.has(edge)
        // Un valor que llega a un nodo que ya lo nombra (una constante, la variable de un bucle, un
        // parámetro, el resultado de otra línea) no se dibuja como cable: es un chip en su casilla.
        if (plan.docked.has(edge.from) || (plan.hidden.has(edge) && !revealed.has(edge))) {
          return false
        }
        // El retorno de un bucle territorio lo dibuja el propio bucle (su carril de repetición).
        if (edge.relation === 'feedback' && scopes[edge.to]?.includes(edge.from)) return false
        return edge.fromPort?.startsWith('param:') || !scopes[edge.from]?.includes(edge.to)
      }),
    [edges, scopes, plan, revealed],
  )

  const parentOf = useMemo(() => {
    const map: Record<string, string> = {}
    for (const [scope, members] of Object.entries(scopes)) for (const id of members) map[id] = scope
    return map
  }, [scopes])

  /** Todo lo que hay dentro de un territorio, a cualquier profundidad. */
  const descendantsOf = useCallback(
    (root: string): string[] => {
      const found: string[] = []
      const walk = (scope: string) => {
        for (const id of scopes[scope] ?? []) {
          found.push(id)
          walk(id)
        }
      }
      walk(root)
      return found
    },
    [scopes],
  )

  // El destino tiene que ser estable entre renders: si cambia de identidad en cada uno,
  // la animación se relanzaría sin parar en vez de avanzar.
  // La cajita del programa va arriba del todo, y el resto del plano baja lo que ocupa.
  const moduleTray = plan.trays.get(MODULE)
  const shiftY = moduleTray ? moduleTray.h + 24 : 0
  /** Hasta dónde llega el diagrama; a partir de ahí, el margen de las notas. */
  const diagramW = Math.max(layoutBounds.w, moduleTray ? moduleTray.w + MODULE_TRAY_AT.x * 2 : 0)
  // Con notas, el margen cuenta para el encuadre: el zoom es el mismo llegue la nota que llegue.
  const noteReserve = noteNodes.length > 0 ? NOTE_GUTTER + NOTE.width + 24 : 0
  const bounds = useMemo(
    () => ({ w: diagramW + noteReserve, h: layoutBounds.h + shiftY }),
    [diagramW, noteReserve, layoutBounds.h, shiftY],
  )

  const motionItems = useMemo(
    () =>
      placements.map((placement) => ({
        id: placement.id,
        value: placement,
        position: moved[placement.id] ?? { x: placement.x, y: placement.y + shiftY },
      })),
    [placements, moved, shiftY],
  )

  // El movimiento: las posiciones se interpolan, así que un nodo se puede seguir con la vista.
  const animated = useMotion(motionItems, { disabled: !animate || dragging })

  useEffect(() => {
    shownRef.current = Object.fromEntries(animated.map((item) => [item.id, item.position]))
    boxesRef.current = Object.fromEntries(
      animated.map((item) => [item.id, { ...item.position, ...item.value.size }]),
    )
  }, [animated])

  /** Lo que la selección ilumina: el nodo elegido y, si es un territorio, todo su interior. */
  const lit = useMemo(() => {
    if (selectedId === null) return null
    return new Set([selectedId, ...descendantsOf(selectedId)])
  }, [selectedId, descendantsOf])

  /** Lo que se le hace a un nodo desde su cabecera: abrir el editor de código, o escribirlo en el archivo. */
  const onNodeEdit = useCallback(
    (id: string, edit: NodeEdit) => {
      if (edit.type === 'open-code') setCodeFor({ key: fitKey, id })
      else if (edit.type === 'rename')
        onAction?.({ type: 'rename', id, to: edit.to, ...(edit.from ? { from: edit.from } : {}) })
      else onAction?.({ type: edit.type, id })
    },
    [fitKey, onAction],
  )
  const codeNode = codeFor?.key === fitKey ? byId.get(codeFor.id) : undefined

  /** Los extremos de una conexión de React Flow, como los entiende el diagrama. */
  const linkOf = useCallback((connection: Connection | Edge): Link => {
    const port = connection.sourceHandle
    return {
      from: connection.source,
      ...(port?.startsWith('param:') ? { port } : {}),
      to: connection.target,
      slot: connection.targetHandle ?? '',
    }
  }, [])

  /** Mientras se arrastra un cable: dónde valdría soltarlo (los demás puertos se apagan). */
  const eligible = useMemo(() => {
    if (!connecting) return null
    const found: Record<string, string[]> = {}
    for (const node of nodes) {
      const slots = (node.inputs ?? []).filter(
        (slot) => checkConnection(lookup, { ...connecting, to: node.id, slot }).ok,
      )
      if (slots.length > 0) found[node.id] = slots
    }
    return found
  }, [connecting, nodes, lookup])

  /** Un cable de orden soltado sobre un nodo: ese nodo pasa a ejecutarse donde dice el puerto de origen. */
  const orderTo = useCallback(
    (from: string, port: OrderPort, to: string) => {
      const verdict = checkOrder(byId, { from, port, to })
      if (verdict.ok) onAction?.(verdict.action)
      else setNotice(verdict.reason)
    },
    [byId, onAction],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (isOrderHandle(connection.sourceHandle)) {
        if (connection.targetHandle === ORDER_IN) {
          orderTo(connection.source, connection.sourceHandle as OrderPort, connection.target)
        }
        return
      }
      const link = linkOf(connection)
      const verdict = checkConnection(lookup, link)
      if (verdict.ok) {
        onAction?.(
          connectAction({ ...link, ...(verdict.convert ? { convert: verdict.convert } : {}) }),
        )
        if (verdict.convert) setNotice(convertNotice(verdict.name))
      } else setNotice(verdict.reason)
    },
    [lookup, linkOf, onAction, orderTo],
  )

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      setConnecting(null)
      const dragged = ordering
      setOrdering(null)
      if (dragged) {
        // Soltado sobre un nodo pero no sobre su puerto: vale igual, es ese nodo el que se coloca.
        if (!state.isValid && state.toNode) orderTo(dragged.from, dragged.port, state.toNode.id)
        else if (!state.isValid) {
          // En el vacío: se ofrece crear ahí una sentencia nueva.
          const frame = frameRef.current?.getBoundingClientRect()
          const point = 'changedTouches' in event ? event.changedTouches[0] : event
          if (frame && point) {
            setOrderAdd({ ...dragged, x: point.clientX - frame.left, y: point.clientY - frame.top })
          }
        }
        return
      }
      const from = state.fromHandle
      if (state.isValid || !from || from.type !== 'source' || !state.fromNode) return
      const port = from.id?.startsWith('param:') ? from.id : undefined
      const origin = { from: state.fromNode.id, ...(port ? { port } : {}) }
      if (state.toNode) {
        // Soltado sobre un nodo pero no sobre un puerto: si solo hay un campo donde valga, es ese.
        const slots = eligible?.[state.toNode.id] ?? []
        if (!state.toHandle && slots.length === 1 && slots[0] !== undefined) {
          onAction?.(connectAction({ ...origin, to: state.toNode.id, slot: slots[0] }))
          return
        }
        const slot = state.toHandle?.id
        const verdict = slot
          ? checkConnection(lookup, { ...origin, to: state.toNode.id, slot })
          : null
        setNotice(
          verdict && !verdict.ok
            ? verdict.reason
            : 'Suelta el cable sobre el puerto del campo donde quieres usarlo.',
        )
        return
      }
      // En el vacío: se ofrece crear un nodo ya conectado.
      const frame = frameRef.current?.getBoundingClientRect()
      const point = 'changedTouches' in event ? event.changedTouches[0] : event
      const source = byId.get(origin.from)
      if (frame && point && source && outputName(source, port) !== undefined) {
        setQuick({ ...origin, x: point.clientX - frame.left, y: point.clientY - frame.top })
      }
    },
    [byId, lookup, eligible, onAction, ordering, orderTo],
  )

  /** Lo que ofrece el menú de un nodo: lo que se hacía con los iconos de su cabecera, y más. */
  const menuItems = (id: string): NodeMenuItem[] => {
    const node = byId.get(id)
    if (!node) return []
    // Un visor solo se quita: no es una sentencia, no hay nada que duplicar ni eliminar del archivo.
    if (node.viewer) {
      return onUnpin
        ? [
            {
              label: 'Quitar el visor',
              hint: 'Supr',
              onSelect: () => {
                onUnpin(id)
              },
            },
          ]
        : []
    }
    const items: NodeMenuItem[] = []
    if (onRun) {
      items.push({
        label: 'Ejecutar',
        hint: 'Mayús+Intro',
        onSelect: () => {
          onRun(id)
        },
      })
    }
    items.push(...(extraMenu?.(id) ?? []))
    if (node.renamable) {
      items.push({
        label: 'Renombrar',
        onSelect: () => {
          setRenaming((previous) => ({ id, n: previous.n + 1 }))
        },
      })
    }
    if (node.openable && onEnter) {
      items.push({
        label: node.opens ? `Ver la función de ${node.label}` : scopes[id] ? 'Plegar' : 'Abrir',
        onSelect: () => {
          onEnter(id)
        },
      })
    }
    // Un valor del flujo puede subir a las variables de su contexto: pasa a ser una inicialización.
    const before = plan.docked.has(id) ? null : promoteTarget(nodes, node)
    if (before) {
      items.push({
        label: 'Subir a las variables del contexto',
        onSelect: () => {
          onAction?.({ type: 'move', id, before })
        },
      })
    }
    items.push(
      {
        label: 'Duplicar',
        onSelect: () => {
          onAction?.({ type: 'duplicate', id })
        },
      },
      {
        label: 'Editar como código',
        onSelect: () => {
          setCodeFor({ key: fitKey, id })
        },
      },
      {
        label: 'Eliminar',
        danger: true,
        hint: 'Supr',
        onSelect: () => {
          onAction?.({ type: 'delete', id })
        },
      },
    )
    return items
  }

  /** Suelta el cable seleccionado: el campo vuelve a un valor neutro. */
  const disconnect = useCallback(
    (edge: SemanticEdge) => {
      if (edge.toPort === undefined) return
      // Un cable al retorno de una función que se dibuja saltándose su `return`: soltarlo es quitar ese `return`.
      if (edge.via !== undefined) onAction?.({ type: 'delete', id: edge.via })
      else onAction?.({ type: 'disconnect', id: edge.to, slot: edge.toPort })
      setEdgeState(null)
    },
    [onAction, setEdgeState],
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return
    if (event.shiftKey && event.key.toLowerCase() === 'f') {
      // Reordenar: la gramática vuelve a colocar todo, olvidando lo que se movió a mano.
      event.preventDefault()
      setMovedState({ key: fitKey, positions: NO_POSITIONS })
      return
    }
    if (!connectable || (event.key !== 'Delete' && event.key !== 'Backspace')) return
    const cable = visibleEdges.find((edge) => edgeKey(edge) === edgeId)
    if (edgeId !== null && cable) {
      event.preventDefault()
      disconnect(cable)
    } else if (selectedId !== null && byId.get(selectedId)?.viewer) {
      event.preventDefault()
      onUnpin?.(selectedId)
    } else if (selectedId !== null && byId.has(selectedId) && scopes[selectedId] === undefined) {
      // Un territorio (una función, un bucle) lleva mucho dentro: eliminarlo pide el botón, no una tecla.
      event.preventDefault()
      onAction?.({ type: 'delete', id: selectedId })
    }
  }

  /** Añadir una variable al principio de un contexto (donde se inicializan). */
  const onAddChip = useCallback(
    (context: string) => {
      onAction?.({
        type: 'add',
        template: 'variable',
        at: 'start',
        ...(context === MODULE ? {} : { into: context }),
      })
    },
    [onAction],
  )
  /** Al seleccionar un chip, dónde se usa: su conexión no se dibuja, así que se marcan las casillas. */
  const litSlots = useMemo(() => {
    const map: Record<string, string[]> = {}
    if (selectedId === null) return map
    const iter = parseIterChip(selectedId)
    for (const edge of edges) {
      if (!edge.toPort || !plan.hidden.has(edge)) continue
      const mine = iter
        ? edge.from === iter.loop && edge.fromPort === `param:${iter.name}`
        : edge.from === selectedId
      if (mine) (map[edge.to] ??= []).push(edge.toPort)
    }
    return map
  }, [selectedId, plan, edges])

  /** A quién se puede llamar: las funciones del programa (como chips) y las de uso común. */
  const callees = useMemo(
    () => [...new Set([...(palette ?? []).map((fn) => fn.name), ...COMMON_CALLS])],
    [palette],
  )
  /**
   * Un cambio en el editor de un nodo. Cambiar a quién llama una llamada no es solo reescribir un
   * nombre: la lista de argumentos se ajusta a los parámetros de la nueva función, y eso lo sabe la
   * acción `callee`, no el campo.
   */
  const changeControl = useCallback(
    (id: string, next: ControlModel) => {
      const before = byId.get(id)?.control
      if (
        onAction &&
        before?.kind === 'args' &&
        next.kind === 'args' &&
        before.target !== '' &&
        before.target !== next.target &&
        next.target.trim() !== ''
      ) {
        onAction({ type: 'callee', id, callee: next.target.trim() })
        return
      }
      onControlChange?.(id, next)
    },
    [byId, onAction, onControlChange],
  )
  /** Quitar el chip de una casilla: vuelve a un valor neutro. */
  const onClearChip = useCallback(
    (id: string, slot: string) => {
      // Lo que devuelve una función es una sentencia `return`: quitarlo es quitarla.
      if (slot === 'return') {
        const via = edges.find((edge) => edge.to === id && edge.toPort === 'return')?.via
        if (via !== undefined) onAction?.({ type: 'delete', id: via })
        return
      }
      onAction?.({ type: 'disconnect', id, slot })
    },
    [edges, onAction],
  )

  /** Se ensancha una función a mano: se recuerda su tamaño, y la gramática lo respeta como mínimo. */
  const onResize = useCallback(
    (id: string, size: { w: number; h: number }) => {
      setResizedState((previous) => ({
        key: fitKey,
        sizes: { ...(previous.key === fitKey ? previous.sizes : NO_SIZES), [id]: size },
      }))
    },
    [fitKey],
  )

  /** Las funciones que se ven, con dónde están ahora: sobre ellas se puede soltar un nodo. */
  const territories = useMemo(
    () =>
      animated
        .filter((item) => scopes[item.id] !== undefined)
        .map((item) => ({
          id: item.id,
          x: item.position.x,
          y: item.position.y,
          w: item.value.size.w,
          h: item.value.size.h,
        })),
    [animated, scopes],
  )

  /** Mientras se arrastra un nodo: ¿a qué función pertenecería si se soltara ahora? */
  const onNodeDrag = useCallback(
    (node: { id: string; position: Point }) => {
      // Solo los nodos cambian de función; una función arrastrada se lleva lo suyo, no se reubica.
      if (!connectable || scopes[node.id] !== undefined) return
      const box = animated.find((item) => item.id === node.id)?.value.size
      if (!box) return
      const center = { x: node.position.x + box.w / 2, y: node.position.y + box.h / 2 }
      const to = territoryAt(center, territories, new Set([node.id, ...descendantsOf(node.id)]))
      const from = parentOf[node.id] ?? null
      setReparent((previous) => {
        if (to === from) return previous === null ? previous : null
        return previous?.id === node.id && previous.to === to ? previous : { id: node.id, to, from }
      })
    },
    [animated, connectable, descendantsOf, parentOf, scopes, territories],
  )

  /** Al soltar: si el nodo ha cambiado de función, se mueve su sentencia en el código. */
  const onNodeDrop = useCallback(
    (id: string) => {
      const change = reparent
      setReparent(null)
      if (!change || change.id !== id) return
      if (change.to !== null) {
        onAction?.({ type: 'move', id, into: change.to })
      } else if (change.from !== null) {
        // Fuera de todas: detrás de la función más externa en la que estaba.
        let outer = change.from
        for (let up = parentOf[outer]; up !== undefined; up = parentOf[up]) outer = up
        onAction?.({ type: 'move', id, after: outer })
      }
      // El nodo se vuelve a colocar donde lo pone la gramática, ya en su función.
      setMovedState((previous) => {
        if (previous.key !== fitKey) return previous
        const rest = Object.fromEntries(
          Object.entries(previous.positions).filter(([key]) => key !== id),
        )
        return { key: fitKey, positions: rest }
      })
    },
    [fitKey, onAction, parentOf, reparent],
  )

  /** Un valor que no cabe en ninguna cajita se coloca en el plano, pero también como píldora. */
  const chipNode = (
    node: CanvasNode,
    position: Point,
    size: { w: number; h: number },
  ): ChipFlowNode => ({
    id: node.id,
    type: 'chip' as const,
    position: chipDrag.carried?.id === node.id ? chipDrag.carried.position : position,
    ...nodeFrame(size),
    selected: node.id === selectedId,
    zIndex: 5,
    draggable: interactive,
    selectable: interactive,
    data: {
      chip: node,
      size,
      ...(onControlChange ? { onControlChange: changeControl } : {}),
      ...(onAction
        ? { onRename: (id: string, to: string) => onAction({ type: 'rename', id, to }) }
        : {}),
      renameSignal: renaming.id === node.id ? renaming.n : 0,
    },
  })

  /** Un visor: una ventana con el valor de otro nodo. Se coloca como cualquier nodo, pero no es código. */
  const viewerNode = (
    node: CanvasNode,
    content: ViewerContent,
    position: Point,
    size: { w: number; h: number },
  ): ViewerFlowNode => ({
    id: node.id,
    type: 'viewer' as const,
    position,
    ...nodeFrame(size),
    selected: node.id === selectedId,
    zIndex: 4,
    draggable: interactive,
    selectable: interactive,
    data: { node, content, size, ...(onUnpin ? { onUnpin } : {}) },
  })

  const flowNodes: AnyFlowNode[] = animated.flatMap((item): AnyFlowNode[] => {
    const node = byId.get(item.id)
    if (!node) return []
    if (node.viewer) return [viewerNode(node, node.viewer, item.position, item.value.size)]
    if (isChipKind(node)) return [chipNode(node, item.position, item.value.size)]
    // Es un territorio solo si el layout le ha encontrado un interior: colapsada, una función es un nodo más.
    const container = scopes[item.id] !== undefined
    return [
      {
        id: item.id,
        type: 'prysel' as const,
        position: item.position,
        // Ya medido: sin esto, mover un nodo le borra los puertos y las conexiones (ver frame.ts).
        ...nodeFrame(item.value.size),
        selected: item.id === selectedId,
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
          renameSignal: renaming.id === node.id ? renaming.n : 0,
          showStatus,
          linkedSlots: linked[node.id] ?? [],
          connectable,
          eligible: eligible ? (eligible[node.id] ?? []) : null,
          // Al arrastrar un nodo: la función que lo recibiría, y la que lo perdería.
          drop: reparent?.to === node.id ? 'into' : reparent?.from === node.id ? 'out' : undefined,
          addTarget: addTarget === node.id,
          cursor: cursor === node.id,
          // La cajita de chips del territorio, y lo que llevan las casillas de este nodo.
          tray: container ? plan.trays.get(node.id) : undefined,
          chipSlots: plan.chipSlots[node.id],
          chipOnly: chipOnly[node.id],
          chipDragging: chipDrag.carried !== null || ghost !== null,
          line: isLineCard(node.kind, node.control) && densityOf(node) === 'normal',
          ...(connectable ? { onGrabResult: grabResult } : {}),
          callees,
          litSlots: litSlots[node.id],
          hotSlot:
            chipDrag.hover?.nodeId === node.id
              ? {
                  slot: chipDrag.hover.slot,
                  ok: chipDrag.hover.ok,
                  ...(chipDrag.hover.convert ? { convert: true } : {}),
                }
              : null,
          ...(connectable ? { onAddChip, onClearChip } : {}),
          ...(container && interactive ? { onResize } : {}),
          phase: item.phase,
          ...(onControlChange ? { onControlChange: changeControl } : {}),
          ...(onAction ? { onNodeEdit } : {}),
          ...(onEnter ? { onEnter } : {}),
        },
      },
    ]
  })

  /**
   * Los chips acoplados y la cajita del programa. Cada cajita cuelga de su contexto: si el
   * territorio se mueve o se anima, sus chips van con él. Un chip que se lleva sigue al puntero.
   */
  const dockedNodes: AnyFlowNode[] = []
  {
    const positionOf = new Map(animated.map((item) => [item.id, item.position]))
    for (const [context, tray] of plan.trays) {
      let origin: Point | undefined
      if (context === MODULE) {
        origin = MODULE_TRAY_AT
        dockedNodes.push({
          id: 'tray:module',
          type: 'tray' as const,
          position: origin,
          ...nodeFrame({ w: tray.w, h: tray.h }),
          zIndex: 0,
          draggable: false,
          selectable: false,
          focusable: false,
          data: {
            tray,
            label: 'Variables y funciones del programa',
            ...(connectable && addToModule
              ? {
                  onAdd: () => {
                    onAddChip(MODULE)
                  },
                }
              : {}),
          },
        })
      } else {
        const at = positionOf.get(context)
        const owner = byId.get(context)
        if (!at || !owner || scopes[context] === undefined) continue
        const inset = SCOPE_FRAME.side
        origin = { x: at.x + inset, y: at.y + SCOPE_FRAME.top + territoryHeadroom(owner) }
      }
      const variables = plan.chipsOf.get(context) ?? []
      for (const placed of tray.chips) {
        const chip = variables.find((candidate) => candidate.id === placed.id)
        const iter = chip ? null : parseIterChip(placed.id)
        const fn =
          chip || iter
            ? undefined
            : plan.functions.find((f) => `${FUNCTION_CHIP}${f.id}` === placed.id)
        if (!chip && !fn && !iter) continue
        const size = chip
          ? chipSize(chip)
          : iter
            ? iterChipSize(iter.name)
            : functionChipSize(fn as FunctionChip)
        const carried = chipDrag.carried?.id === placed.id ? chipDrag.carried.position : undefined
        dockedNodes.push({
          id: placed.id,
          type: 'chip' as const,
          position: carried ?? { x: origin.x + placed.x, y: origin.y + placed.y },
          ...nodeFrame(size),
          zIndex: 5,
          draggable: interactive,
          selectable: interactive && fn === undefined,
          selected: placed.id === selectedId,
          data: {
            size,
            ...(chip ? { chip } : {}),
            ...(fn ? { fn } : {}),
            ...(iter
              ? {
                  iter: {
                    name: iter.name,
                    param: byId.get(iter.loop)?.kind === 'abstraction.collapsed',
                    icon: getKind(byId.get(iter.loop)?.kind ?? 'control.loop').icon,
                  },
                }
              : {}),
            ...(onControlChange ? { onControlChange: changeControl } : {}),
            ...(onAction
              ? { onRename: (id: string, to: string) => onAction({ type: 'rename', id, to }) }
              : {}),
            renameSignal: renaming.id === placed.id ? renaming.n : 0,
          },
        })
      }
    }
  }

  // Lo que las conexiones tienen que esquivar: cada nodo y cada territorio, donde están ahora.
  const obstacles = useMemo(
    () =>
      animated.map((item) => ({
        id: item.id,
        x: item.position.x,
        y: item.position.y,
        w: item.value.size.w,
        h: item.value.size.h,
      })),
    [animated],
  )

  const isCompact = (id: string) => {
    const node = byId.get(id)
    return node !== undefined && densityOf(node) === 'compact'
  }
  const flowEdges: PryselFlowEdge[] = visibleEdges.map((edge) => ({
    id: edgeKey(edge),
    selected: edgeId === edgeKey(edge),
    source: edge.from,
    target: edge.to,
    // En compacto un nodo no tiene casillas (ni puertos por campo): todo entra y sale por el borde.
    // Un resultado entre varios es un chip: su cable, si se dibuja, sale por el puerto normal.
    sourceHandle:
      edge.fromPort && !edge.fromPort.startsWith('result:') && !isCompact(edge.from)
        ? edge.fromPort
        : 'out',
    targetHandle: edge.toPort && !isCompact(edge.to) ? edge.toPort : 'in',
    type: 'prysel' as const,
    ...(edge.label === undefined ? {} : { label: edge.label }),
    markerEnd: `url(#prysel-arrow-${channelOf(edge) === 'control' ? 'thick' : 'thin'})`,
    // Con algo seleccionado, sus conexiones destacan y el resto se retira.
    ...(lit ? { zIndex: lit.has(edge.from) || lit.has(edge.to) ? 10 : 0 } : {}),
    data: {
      relation: edge.relation,
      channel: channelOf(edge),
      obstacles,
      parentOf,
      axis,
      ...(connectable &&
      edge.toPort !== undefined &&
      (edge.toPort !== 'return' || edge.via !== undefined) &&
      byId.get(edge.to)?.inputs?.includes(edge.toPort)
        ? {
            removable: true,
            onRemove: () => {
              disconnect(edge)
            },
          }
        : {}),
      ...(lit ? { emphasis: lit.has(edge.from) || lit.has(edge.to) ? 'active' : 'dim' } : {}),
      live:
        stateOf !== undefined && stateOf(edge.from) === 'success' && stateOf(edge.to) !== 'dormant',
    },
  }))

  /**
   * Las notas: cada una en el margen a la derecha del diagrama, a la altura de lo que explica, con su flecha
   * a mano. Las que aún no llegaron ocupan su sitio pero no se dibujan.
   */
  const noteFlow = (() => {
    const nodesOut: NoteFlowNode[] = []
    const edgesOut: PryselFlowEdge[] = []
    if (noteNodes.length === 0) return { nodes: nodesOut, edges: edgesOut }
    const rects = new Map<string, { x: number; y: number; w: number; h: number }>()
    for (const flow of [...flowNodes, ...dockedNodes]) {
      const size = (flow.data as { size?: { w: number; h: number } }).size
      if (size) rects.set(flow.id, { ...flow.position, ...size })
    }
    const linkOf = new Map(noteLinks.map((link) => [link.to, link]))
    const slots: NoteSlot[] = []
    for (const note of noteNodes) {
      const anchor = rects.get(linkOf.get(note.id)?.from ?? '')
      if (anchor && note.handwritten) {
        slots.push({ id: note.id, anchor, size: noteSize(note.handwritten) })
      }
    }
    const placed = placeNotes(slots, diagramW + NOTE_GUTTER)
    for (const note of noteNodes) {
      const content: NoteContent | undefined = note.handwritten
      const at = placed.get(note.id)
      const link = linkOf.get(note.id)
      if (!content || content.hidden || !at || !link) continue
      const size = noteSize(content)
      nodesOut.push({
        id: note.id,
        type: 'note' as const,
        position: at,
        ...nodeFrame(size),
        zIndex: 4,
        draggable: false,
        selectable: false,
        focusable: false,
        data: { note: content, size },
      })
      edgesOut.push({
        id: `note-${link.from}-${note.id}`,
        source: link.from,
        target: note.id,
        // La flecha sale de un asa invisible a la derecha de lo que explica (un chip o un territorio no tienen otra).
        sourceHandle: 'note-out',
        targetHandle: 'in',
        type: 'prysel' as const,
        markerEnd: 'url(#prysel-arrow-thin)',
        zIndex: 6,
        data: {
          relation: 'transform',
          channel: 'data',
          note: true,
          obstacles,
          parentOf,
          axis,
        },
      })
    }
    return { nodes: nodesOut, edges: edgesOut }
  })()

  /** Dónde están las notas que se dibujan: la cámara las busca cuando toca leer la actual. */
  const noteBoxesRef = useRef<Record<string, { x: number; y: number; w: number; h: number }>>({})
  useEffect(() => {
    noteBoxesRef.current = Object.fromEntries(
      noteFlow.nodes.map((n) => [n.id, { ...n.position, ...n.data.size }]),
    )
  })
  const currentNote = noteNodes.find((n) => n.handwritten?.current)?.id ?? null

  // La reproducción: la cámara sigue al cursor y a la nota que se está leyendo, pero solo si se salen de lo
  // que se ve. Si caben las dos, se centra entre ellas; si no, manda la nota (es lo que se lee).
  useEffect(() => {
    const frame = frameRef.current
    const cursorBox = cursor === null ? undefined : boxesRef.current[cursor]
    const noteBox = currentNote === null ? undefined : noteBoxesRef.current[currentNote]
    const boxes = [cursorBox, noteBox].filter((box) => box !== undefined)
    if (!frame || boxes.length === 0) return
    const { x, y, zoom } = getViewport()
    const margin = 48
    const inside = boxes.every(
      (box) =>
        box.x * zoom + x >= margin &&
        box.y * zoom + y >= margin &&
        (box.x + box.w) * zoom + x <= frame.clientWidth - margin &&
        (box.y + box.h) * zoom + y <= frame.clientHeight - margin,
    )
    if (inside) return
    const left = Math.min(...boxes.map((box) => box.x))
    const top = Math.min(...boxes.map((box) => box.y))
    const right = Math.max(...boxes.map((box) => box.x + box.w))
    const bottom = Math.max(...boxes.map((box) => box.y + box.h))
    // El zoom con el que caben las dos cosas; si hay que alejarse demasiado, no merece la pena.
    const room = Math.min(
      (frame.clientWidth - 2 * margin) / (right - left),
      (frame.clientHeight - 2 * margin) / (bottom - top),
    )
    const both = Math.min(zoom, room)
    // Si no caben las dos, manda lo que se ejecuta: perder el diagrama de vista es peor que leer la nota a medias.
    const only = cursorBox ?? noteBox
    const together = both >= MIN_FOLLOW_ZOOM || !only
    const target = together
      ? { x: (left + right) / 2, y: (top + bottom) / 2 }
      : { x: only.x + only.w / 2, y: only.y + only.h / 2 }
    void setCenter(target.x, target.y, {
      zoom: together ? both : zoom,
      duration: animate ? 350 : 0,
    })
  }, [cursor, currentNote, getViewport, setCenter, animate])

  const onNodesChange = useCallback(
    (changes: NodeChange<AnyFlowNode>[]) => {
      for (const change of changes) {
        if (change.type !== 'position' || !change.position) continue
        const { id, position } = change
        // Un chip se lleva hasta una casilla y vuelve a su cajita: no cambia de sitio en el plano.
        if (isDockedChip(id)) {
          chipDrag.carry(id, position)
          continue
        }
        const inside = descendantsOf(id)
        // Una instantánea: el actualizador de estado no debe leer una referencia mutable.
        const shown = shownRef.current
        setMovedState((previous) => {
          const base = previous.key === fitKey ? previous.positions : NO_POSITIONS
          return { key: fitKey, positions: dragTerritory(base, shown, id, position, inside) }
        })
      }
    },
    [descendantsOf, fitKey, isDockedChip, chipDrag],
  )

  // Al cambiar el programa, el encuadre se rehace — salvo que el usuario ya lo haya movido.
  const shape = `${fitKey}|${bounds.w}x${bounds.h}:${placements.length}`
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

  // Un lienzo de trabajo (que se ajusta al ancho) pliega sus filas según el ancho que tiene.
  const narrowing = interactive && (fitMode ?? 'width') === 'width'
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !narrowing) return
    // El observador avisa nada más empezar a mirar: no hace falta medir a mano.
    const observer = new ResizeObserver(() => {
      setRun(runFor(frame.clientWidth))
    })
    observer.observe(frame)
    return () => {
      observer.disconnect()
    }
  }, [narrowing])

  const onMoveStart = useCallback(
    (event: unknown) => {
      // Un movimiento sin evento es programático (el propio reencuadre): no cuenta como tomar el control.
      if (event) setTakenKey(fitKey)
    },
    [fitKey],
  )

  const canvasHeight = height ?? Math.max(minHeight, Math.min(bounds.h, MAX_HEIGHT))

  return (
    // El lienzo recoge el teclado (Supr, Mayús+F) cuando se ha hecho clic en él.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className={['canvas stage rounded-lg border border-border-card', className]
        .filter(Boolean)
        .join(' ')}
      ref={frameRef}
      style={{ height: canvasHeight === 'fill' ? '100%' : canvasHeight }}
      data-interactive={interactive ? '' : undefined}
      data-selection={selectedId === null ? undefined : ''}
      data-linking={connecting ? '' : undefined}
      data-ordering={ordering ? '' : undefined}
      role="group"
      aria-label={ariaLabel ?? 'Diagrama del programa'}
      onKeyDown={interactive ? onKeyDown : undefined}
      onPointerDown={
        interactive
          ? (event) => {
              if (!(event.target as HTMLElement).closest('input, textarea, select, button')) {
                frameRef.current?.focus({ preventScroll: true })
              }
            }
          : undefined
      }
      tabIndex={interactive ? -1 : undefined}
    >
      {/* Las puntas de flecha viven en un svg propio: React Flow no las declara por nosotros. */}
      <svg className="canvas__defs" aria-hidden>
        <EdgeDefs />
      </svg>
      <ReactFlow
        nodes={[...flowNodes, ...dockedNodes, ...noteFlow.nodes]}
        edges={[...flowEdges, ...noteFlow.edges]}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={interactive ? onNodesChange : undefined}
        onMoveStart={interactive ? onMoveStart : undefined}
        onNodeClick={
          interactive
            ? (_, node) => {
                if (node.id !== 'tray:module' && !node.id.startsWith(FUNCTION_CHIP)) select(node.id)
              }
            : undefined
        }
        onEdgeClick={
          connectable
            ? (_, edge) => {
                setEdgeState({ key: fitKey, id: edge.id })
              }
            : undefined
        }
        onPaneClick={
          interactive
            ? () => {
                select(null)
                setQuick(null)
                setMenu(null)
              }
            : undefined
        }
        onNodeContextMenu={
          connectable && showActions
            ? (event, node) => {
                // El menú del navegador no pinta nada aquí: se abre el del nodo, junto al puntero.
                event.preventDefault()
                const frame = frameRef.current?.getBoundingClientRect()
                if (!frame) return
                select(node.id)
                setQuick(null)
                setMenu({
                  id: node.id,
                  x: event.clientX - frame.left,
                  y: event.clientY - frame.top,
                })
              }
            : undefined
        }
        onConnect={connectable ? onConnect : undefined}
        onConnectStart={
          connectable
            ? (_, { nodeId, handleId, handleType }) => {
                setQuick(null)
                // Un cable de orden no es un cable de datos: no busca casillas donde soltarse.
                if (nodeId !== null && isOrderHandle(handleId) && handleType === 'source') {
                  setOrdering({ from: nodeId, port: handleId as OrderPort })
                  return
                }
                setConnecting(
                  handleType === 'source' && nodeId !== null
                    ? {
                        from: nodeId,
                        ...(handleId?.startsWith('param:') ? { port: handleId } : {}),
                      }
                    : null,
                )
              }
            : undefined
        }
        onConnectEnd={connectable ? onConnectEnd : undefined}
        isValidConnection={(connection) =>
          isOrderHandle(connection.sourceHandle) || isOrderHandle(connection.targetHandle)
            ? connection.targetHandle === ORDER_IN &&
              isOrderHandle(connection.sourceHandle) &&
              checkOrder(byId, {
                from: connection.source,
                port: connection.sourceHandle as OrderPort,
                to: connection.target,
              }).ok
            : checkConnection(lookup, linkOf(connection)).ok
        }
        connectionRadius={22}
        connectOnClick={false}
        deleteKeyCode={null}
        onNodeDragStart={
          interactive
            ? (_, node) => {
                // Arrastrar un nodo lo selecciona: React Flow mueve a la vez todo lo seleccionado,
                // y si quedara otro nodo elegido se desplazaría también, sumándose a mi propio arrastre.
                if (!node.id.startsWith(FUNCTION_CHIP)) select(node.id)
                setDragging(true)
              }
            : undefined
        }
        onNodeDrag={
          interactive
            ? (event, node) => {
                if (isDockedChip(node.id)) {
                  const point = 'touches' in event ? event.touches[0] : event
                  if (point) chipDrag.over(node.id, point)
                } else onNodeDrag(node)
              }
            : undefined
        }
        onNodeDragStop={
          interactive
            ? (_, node) => {
                setDragging(false)
                if (isDockedChip(node.id)) chipDrag.drop(node.id)
                else onNodeDrop(node.id)
              }
            : undefined
        }
        minZoom={0.15}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={interactive}
        nodesConnectable={connectable}
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
        // Un territorio seleccionado no debe subir por encima de los nodos que envuelve: su área
        // cubre todo el interior y se tragaría los clics de sus hijos. El orden lo decide el lienzo.
        elevateNodesOnSelect={false}
      >
        {interactive && <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />}
        {interactive && Object.keys(moved).length > 0 && (
          <Panel position="top-right">
            <button
              type="button"
              className="canvas__tool"
              title="Volver a colocar todo (Mayús+F)"
              onClick={() => {
                setMovedState({ key: fitKey, positions: NO_POSITIONS })
              }}
            >
              Reordenar
            </button>
          </Panel>
        )}
      </ReactFlow>
      {menu && byId.get(menu.id) && (
        <NodeMenu
          x={menu.x}
          y={menu.y}
          title={byId.get(menu.id)?.label ?? ''}
          items={menuItems(menu.id)}
          onClose={() => {
            setMenu(null)
          }}
        />
      )}
      {ghost && (
        <span
          className="vchip vchip--result vchip--ghost"
          data-type={ghost.type}
          style={{ left: ghost.x, top: ghost.y }}
          aria-hidden
        >
          <span className="node__title type-node-title">{ghost.name}</span>
        </span>
      )}
      {notice !== null && (
        <p className="canvas__notice" role="status">
          {notice}
        </p>
      )}
      {orderAdd && byId.get(orderAdd.from) && (
        <QuickAdd
          x={orderAdd.x}
          y={orderAdd.y}
          title="Crear aquí…"
          onPick={(template) => {
            onAction?.({ type: 'add', template, ...orderPlace(orderAdd.from, orderAdd.port) })
            setOrderAdd(null)
          }}
          onClose={() => {
            setOrderAdd(null)
          }}
        />
      )}
      {quick && byId.get(quick.from) && (
        <QuickAdd
          x={quick.x}
          y={quick.y}
          type={byId.get(quick.from)?.valueType ?? 'any'}
          name={outputName(byId.get(quick.from) as CanvasNode, quick.port) ?? ''}
          onPick={(template) => {
            const source = byId.get(quick.from)
            if (source) {
              onAction?.({
                type: 'add',
                template,
                ...dropTarget(source, quick.port),
                connect: { from: quick.from, ...(quick.port ? { port: quick.port } : {}) },
              })
            }
            setQuick(null)
          }}
          onClose={() => {
            setQuick(null)
          }}
        />
      )}
      {codeNode?.text !== undefined && (
        <CodePanel
          // Una clave por nodo: al pasar a editar otro, el panel empieza de nuevo con su texto.
          key={codeNode.id}
          title={codeNode.label}
          {...(codeNode.line === undefined ? {} : { line: codeNode.line })}
          initial={codeNode.text}
          onApply={(text) => {
            setCodeFor(null)
            onAction?.({ type: 'code', id: codeNode.id, text })
          }}
          onCancel={() => {
            setCodeFor(null)
          }}
        />
      )}
    </div>
  )
}
