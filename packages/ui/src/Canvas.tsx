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
  questionSize,
  sectionCardSize,
  opensWidth,
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
  TAIL_GAP,
  channelOf,
  layout,
  tailSide,
  type Architecture,
  type Axis,
  type Figure,
  type ModuleRole,
  type SemanticEdge,
  type SemanticGraph,
} from '@prysel/spatial'
import { EdgeDefs } from './Edge.tsx'
import { NoteNode, type NoteFlowNode } from './flow/NoteNode.tsx'
import { NOTE, NOTE_GUTTER, noteSize, placeNotes, type NoteContent, type NoteSlot } from './note.ts'
import { PryselNode, type PryselFlowNode } from './flow/PryselNode.tsx'
import { PryselEdge, type PryselFlowEdge } from './flow/PryselEdge.tsx'
import {
  ArchEdge,
  archPath,
  clearBend,
  labelSize,
  labelSpot,
  type ArchFlowEdge,
} from './flow/ArchEdge.tsx'
import { FigureNode, type FigureFlowNode } from './flow/FigureNode.tsx'
import { dragTerritory, territoryAt } from './drag.ts'
import {
  FLOW_LANE,
  FLOW_RAIL,
  flowEntry,
  flowFoot,
  isLoopTerritory,
  isTerritory,
  nodeFrame,
  territoryHeadroom,
} from './flow/frame.ts'
import { useMotion } from './motion.ts'
import type { ControlModel } from './controls.tsx'
import { CodePanel } from './CodePanel.tsx'
import { QuickAdd } from './QuickAdd.tsx'
import { NodeMenu, type NodeMenuItem } from './NodeMenu.tsx'
import { IconButton } from './chrome.tsx'
import { ChipNode, TrayNode, type ChipFlowNode, type TrayFlowNode } from './flow/ChipNode.tsx'
import { ViewerNode, type ViewerFlowNode } from './flow/ViewerNode.tsx'
import { gistSize, titledScene, type GistScene } from './gist.ts'
import { viewerSize, type ViewerContent } from './viewer.ts'
import type { LapsView } from './laps.ts'
import { archRunFor, roomFor, runFor } from './fit.ts'
import { flowHues, flowName, RESULT_BEAT } from './architecture.ts'
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
  namedBy,
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
import { resolveSectionAction, type SectionInfo, type Subprocess } from './program.ts'
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
  /** En una decisión: el `elif` en el que sigue su camino falso (sus puertos son los de ese `elif`). */
  continues?: string
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
  /** Su última línea, si abarca varias (un bloque). */
  lineEnd?: number
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
   * que dice al pasar el puntero (`ndarray 200×2 float64`). `changed`: reproduciendo una lección, este paso
   * concreto acaba de escribirlo — el chip lo anuncia con un pulso. Nunca cambia lo que significa el código.
   */
  observed?: Readonly<Record<string, { short?: string; long: string; changed?: boolean }>>
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
  /**
   * Es una **etapa** (o un bucle que encabeza una): su número en el esquema, su título y lo que dice de
   * ella plegada. Ver `withSections`.
   */
  section?: SectionInfo
  /** Las funciones, clases y métodos del archivo a los que llama: pastillas que los abren. */
  subprocesses?: readonly Subprocess[]
  /**
   * En una función: «qué hace», con los datos de una vez que se ejecutó de verdad. Plegada, se dibuja como
   * esa tarjeta (lo que entró → lo que salió) en vez de su cabecera sola.
   */
  gist?: GistScene
}

export interface CanvasProps {
  nodes: CanvasNode[]
  edges: SemanticEdge[]
  density: Density
  stateOf?: (id: string) => NodeState
  /**
   * Reproduciendo una lección con construcción progresiva: un nodo que la ejecución aún no ha alcanzado
   * se atenúa (`'pending'`) hasta que le toque. Igual que `stateOf`, por id: la app decide, el lienzo dibuja.
   */
  modifierOf?: (id: string) => 'dead' | 'generating' | 'pending' | undefined
  /**
   * Una nota se arrastró a mano: cuánto se aparta ahora del sitio que le da el margen (`null`: se devolvió
   * a su sitio con doble clic). Sin él, las notas no se arrastran.
   */
  onNoteMove?: (id: string, offset: { x: number; y: number } | null) => void
  onControlChange?: (id: string, next: ControlModel) => void
  /** Lo que el usuario le hace a un nodo: reescribirlo como código, eliminarlo, duplicarlo, renombrarlo. */
  onAction?: (action: NodeAction) => void
  /** Abrir un subproceso (la función, la clase o el método al que llama un nodo) desde su pastilla. */
  onOpen?: (id: string) => void
  /** Probar con otros datos la función de una tarjeta «Qué hace». */
  onGistEdit?: (id: string) => void
  /**
   * La arquitectura del programa: con ella, el primer nivel no baja en columna sino que coloca sus módulos
   * (las etapas de arriba) según su forma, con las flechas de lo que los une y su figura de fondo. Solo en
   * el diagrama de flujo.
   */
  architecture?: Architecture | null
  /**
   * Algo ocupa el rincón de abajo a la derecha del lienzo (la consola): lo que mide. El encuadre deja ese
   * rincón libre, a un lado o por encima, según cómo se vea más grande el diagrama.
   */
  avoid?: { w: number; h: number } | null
  /**
   * El **resultado** del programa, como un nodo más al final de la arquitectura: lo último que salió por
   * pantalla. `from`: los módulos que lo escribieron (le llega una flecha de cada uno); `planned`, si aún
   * no sale del programa sino de una prueba aparte. No es código.
   */
  result?: { content: ViewerContent; from: readonly string[]; planned?: boolean } | null
  /** Dónde **empieza** el trabajo: el módulo que lo arranca y lo que se dice de ello. */
  start?: { at: string; label: string } | null
  /**
   * Por dónde **se sale** de lo que se repite (el módulo que lleva el ciclo) y cómo acabó: su compuerta de
   * salida, un nodo junto a ese módulo. De ella va una flecha al resultado, si no lo escribe la propia vuelta.
   */
  exit?: { at: string; label: string } | null
  /**
   * Al **reproducir** la historia: el módulo en el que se está (o `RESULT_BEAT`, el resultado), las flechas
   * por las que le llega algo (`desde>hasta`), y lo que dura el paso. `serial` cambia en cada paso.
   */
  beat?: { at: string; links: readonly string[]; serial: number; ms: number } | null
  /**
   * Lo que ocupan, arriba y abajo, las barras que flotan sobre el lienzo (las migas, la de ver una vuelta, la
   * leyenda): el encuadre deja esas franjas libres, y la arquitectura se coloca para lo que queda.
   */
  reserve?: { top?: number; bottom?: number } | null
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
   * Sube cada vez que lo que se estaba construyendo ha terminado y se ha asentado: la cámara suelta lo último
   * que fue siguiendo y enseña el programa entero (si cabe a un tamaño que se lea), para verlo de un vistazo.
   * Si el usuario ya movió el lienzo a mano, se respeta.
   */
  settle?: number
  /**
   * Si la cámara acompaña a lo que se señala (lo normal). En falso —mientras se construye un programa
   * entero— lo señalado se sigue iluminando, pero la vista se queda en el conjunto: se ve crecer todo, y no
   * se pierde de vista lo que ya estaba.
   */
  follow?: boolean
  /**
   * El nodo por el que va la reproducción de una traza: se marca con un anillo y, si se sale de la vista,
   * la cámara lo sigue. Sin él, no hay reproducción.
   */
  cursor?: string | null
  /**
   * Llevar la cámara a un nodo y resaltarlo, porque algo acaba de pasar ahí (una orden lo creó o lo nombró).
   * A diferencia del `cursor`, la cámara va siempre, aunque el nodo ya se vea: es un gesto, no un seguimiento.
   * `key` cambia con cada gesto (el mismo nodo se puede volver a enfocar).
   */
  spotlight?: {
    id: string
    key: number
    /** El nodo acaba de construirse: aparece con su animación de entrada. */
    born?: boolean
    /** O acaba de cambiar (se le ve el cambio), o está a punto de quitarse (se despide). */
    change?: 'changed' | 'leaving'
    /** La cámara enseña el nodo con lo que lo rodea, más de lejos, en vez de acercarse a él. */
    wide?: boolean
    /**
     * Adónde mira la cámara, si no es al propio nodo: la caja que lo contiene. Lo de dentro aparece (con su
     * animación) sin que la vista vaya saltando de pieza en pieza.
     */
    camera?: string
  } | null
  /**
   * Los nodos de los que saca sus datos la pieza que se está explicando: laten con ella, para que se vea de
   * dónde viene lo que usa.
   */
  echo?: readonly string[]
  /** Etiqueta accesible del lienzo, leída por lectores de pantalla. */
  ariaLabel?: string
  /**
   * Con marco (borde y esquinas redondeadas): un lienzo dentro de una página. Sin él, ocupa su sitio de borde a
   * borde, como el lienzo de una aplicación.
   */
  framed?: boolean
  /** Enseña los controles flotantes del lienzo (acercar, alejar, encuadrar todo). */
  controls?: boolean
  className?: string
}

/** Una decisión: leída como diagrama de flujo, un rombo con un camino «sí» y uno «no». */
const isDecision = (node: Pick<CanvasNode, 'kind'>) => node.kind === 'control.condition'

/** Los nombres de los subprocesos de un nodo que no es un territorio (en un territorio van en su cabecera). */
const subprocessesOf = (node: Pick<CanvasNode, 'subprocesses'>): string[] =>
  (node.subprocesses ?? []).map((sub) => sub.name)

/** Un nodo con subprocesos lleva sus pastillas en la cabecera: crece lo que ocupan. */
const widen = (size: { w: number; h: number }, node: Pick<CanvasNode, 'subprocesses'>) => {
  const extra = opensWidth(subprocessesOf(node))
  return extra === 0 ? size : { w: Math.min(size.w + extra, 720), h: size.h }
}

/** Una conexión de la secuencia: lo que sigue a un paso, o uno de los caminos de una decisión. */
const isStep = (edge: SemanticEdge) => edge.relation === 'sequence' || edge.relation === 'branch'

/** El papel de una conexión en el diagrama de flujo: de qué puerto sale, a cuál llega y por dónde va. */
interface FlowRole {
  target: string
  sourceHandle: string
  targetHandle: string
  exit: 'bottom' | 'right'
  lane?: number
  tag?: string
  /** A qué altura sobre el destino se junta con los demás caminos (0: llega ya por la línea del carril). */
  bend?: number
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
  figure: FigureNode,
}

/** Todo lo que el lienzo dibuja: nodos, chips y la cajita del programa. */
type AnyFlowNode =
  PryselFlowNode | ChipFlowNode | TrayFlowNode | ViewerFlowNode | NoteFlowNode | FigureFlowNode

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
const EDGE_TYPES = { prysel: PryselEdge, arch: ArchEdge }
/** El nodo del resultado del programa, y lo que se separa de la arquitectura. */
const RESULT_ID = RESULT_BEAT
const RESULT_NODE: CanvasNode = { id: RESULT_ID, kind: 'output.display', label: 'Resultado' }
/** A partir de cuántos módulos que usan lo mismo sus flechas dejan de dibujarse todas a la vez. */
const SHARED_FROM = 3
/** Alto máximo por defecto: a partir de aquí, el lienzo se recorre en vez de crecer. */
const MAX_HEIGHT = 640
/** Hueco entre lo auxiliar (a la izquierda) y el diagrama. */
const SIDE_GAP = 48
/** Lo más que la cámara se aleja para que quepan a la vez el cursor y la nota que se lee. */
const MIN_FOLLOW_ZOOM = 0.45
/** El zoom con el que se enseña una pieza «en su conjunto»: cabe lo que la rodea y aún se lee. */
const WIDE_SPOT_ZOOM = 0.95
/** Lo más que se acerca la cámara a una pieza pequeña. */
const MAX_SPOT_ZOOM = 1.6
/** Lo más que se aleja para enseñar algo que se está explicando: por debajo, ya no se lee. */
const MIN_SPOT_ZOOM = 0.7

type Point = { x: number; y: number }
const NO_POSITIONS: Record<string, Point> = {}
const NO_SIZES: Record<string, { w: number; h: number }> = {}
const NO_PLACED: ReadonlyMap<string, Point> = new Map()

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
  modifierOf,
  onNoteMove,
  onControlChange,
  onAction: sentAction,
  onOpen,
  onGistEdit,
  architecture = null,
  avoid = null,
  result = null,
  start = null,
  exit = null,
  beat = null,
  reserve = null,
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
  settle = 0,
  follow = true,
  cursor = null,
  spotlight = null,
  echo,
  ariaLabel,
  framed = true,
  controls = false,
  className,
}: CanvasProps) {
  /** Las etapas que se ven: lo que se les pide se traduce a su bloque real (ver `resolveSectionAction`). */
  const sectionInfo = useMemo(
    () =>
      new Map(
        allNodes.flatMap((node) =>
          node.kind === 'space.section' && node.section ? [[node.id, node.section] as const] : [],
        ),
      ),
    [allNodes],
  )
  const onAction = useMemo(
    () =>
      sentAction
        ? (action: NodeAction) => {
            const resolved = resolveSectionAction(action, (id) => sectionInfo.get(id))
            if (resolved) sentAction(resolved)
          }
        : undefined,
    [sentAction, sectionInfo],
  )
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
  /** El `código` de una nota por el que pasa el puntero: se iluminan los nodos que nombra. */
  const [hint, setHint] = useState<string | null>(null)
  /** Notas que se están arrastrando o que ya se dejaron en otro sitio (hasta que el guion lo recoja). */
  const [noteMoves, setNoteMoves] = useState<Record<string, Point>>({})
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

  const { setViewport, getViewport, setCenter, zoomIn, zoomOut } = useReactFlow()
  /** Sube cada vez que se pide encuadrar todo otra vez (el botón del lienzo): rehace el encuadre. */
  const [refits, setRefits] = useState(0)
  /**
   * Cuánto mide de largo una fila del diagrama según el ancho del lienzo: en un panel estrecho se pliega
   * antes, para que el programa se lea a un zoom legible y crezca en alto (ver `fit.ts`).
   */
  const [run, setRun] = useState<number | undefined>(undefined)
  /** Lo más ancho que puede ser una fila de módulos de la arquitectura, para el ancho que tiene el lienzo. */
  const [archRun, setArchRun] = useState<number | undefined>(undefined)
  /** Lo que mide el lienzo (a saltos, para no recolocar a cada píxel): la arquitectura se coloca para él. */
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | undefined>(undefined)
  const reserveTop = reserve?.top ?? 0
  const reserveBottom = reserve?.bottom ?? 0
  const archFrame = useMemo(
    () =>
      frameSize
        ? { w: frameSize.w, h: Math.max(200, frameSize.h - reserveTop - reserveBottom) }
        : undefined,
    [frameSize, reserveTop, reserveBottom],
  )
  const frameRef = useRef<HTMLDivElement>(null)
  const lastFit = useRef('')
  /** El diagrama (su `fitKey`) al que una orden llevó la cámara: ahí el encuadre ya no se rehace solo. */
  const spotHeld = useRef<string | null>(null)
  /** Dónde está cada nodo ahora mismo: lo necesita un arrastre para saber cuánto se ha movido. */
  const shownRef = useRef<Record<string, Point>>({})
  const boxesRef = useRef<Record<string, { x: number; y: number; w: number; h: number }>>({})

  const densityOf = useCallback(
    (node: CanvasNode): Density => (density === 'normal' ? (node.density ?? 'normal') : density),
    [density],
  )

  // Las notas no entran en el reparto del diagrama: van en un margen aparte, y aparecer o desaparecer una
  // nota nunca mueve nada de lo que ya estaba.
  // Leído hacia abajo, lo que no es un paso se aparta: las notas a la derecha y los visores a la izquierda.
  const aside = axis === 'vertical'
  /**
   * Leído hacia abajo, el lienzo es un **diagrama de flujo**: los nodos y las conexiones cuentan solo la
   * secuencia (pasos, decisiones en rombo, caminos que se juntan, bucles que vuelven), y las variables viajan
   * únicamente como chips. No hay cables de datos, ni puertos para ellos.
   */
  const flow = aside
  // La compuerta de salida de un ciclo mide lo que su texto: se le hace sitio al colocar.
  const exitLabel = flow && architecture && exit ? exit.label : null
  const gateSize = useMemo(
    () => (exitLabel === null ? undefined : { w: Math.round(exitLabel.length * 6.6 + 48), h: 30 }),
    [exitLabel],
  )
  // El resultado, si lo hay, va a la cola de la arquitectura: cuenta para saber cuánto cabe.
  const tailSize = useMemo(
    () => (result && flow && architecture ? viewerSize(result.content) : undefined),
    [result, flow, architecture],
  )
  const nodes = useMemo(
    () => allNodes.filter((node) => !node.handwritten && !(aside && node.viewer)),
    [allNodes, aside],
  )
  const noteNodes = useMemo(() => allNodes.filter((node) => node.handwritten), [allNodes])
  const sideViewers = useMemo(
    () => (aside ? allNodes.filter((node) => node.viewer) : []),
    [allNodes, aside],
  )
  const noteIds = useMemo(() => new Set(noteNodes.map((node) => node.id)), [noteNodes])
  const viewerIds = useMemo(() => new Set(sideViewers.map((node) => node.id)), [sideViewers])
  const edges = useMemo(
    () => allEdges.filter((edge) => !noteIds.has(edge.to) && !viewerIds.has(edge.to)),
    [allEdges, noteIds, viewerIds],
  )
  const noteLinks = useMemo(
    () => allEdges.filter((edge) => noteIds.has(edge.to)),
    [allEdges, noteIds],
  )
  const viewerLinks = useMemo(
    () => allEdges.filter((edge) => viewerIds.has(edge.to)),
    [allEdges, viewerIds],
  )

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])

  /** El reparto en chips: qué va en cada cajita, qué se coloca en el plano y qué casillas llevan uno. */
  const plan = useMemo(
    () =>
      planChips(nodes, edges, {
        canAdd: connectable,
        column: aside,
        density: densityOf,
        ...(palette ? { palette } : {}),
        addToModule,
      }),
    [nodes, edges, connectable, palette, addToModule, densityOf, aside],
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

  /** Lo que ilumina el `código` de una nota bajo el puntero (y si un trozo de código nombra algo que se vea). */
  const hinted = useMemo(
    () => (hint === null ? null : new Set(namedBy(hint, nodes))),
    [hint, nodes],
  )
  const knowsCode = useCallback((code: string) => namedBy(code, nodes).length > 0, [nodes])

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
    spines,
    figures,
  } = useMemo(() => {
    /** Lo que se dibuja: un ámbito con algo de esto dentro está abierto (si no, está plegado). */
    const present = new Set(plan.flowNodes.map((node) => node.id))
    const graph: SemanticGraph = {
      nodes: plan.flowNodes.map((node) => {
        const spec = getKind(node.kind)
        const d = densityOf(node)
        const base = nodeSize(spec, d, node.metrics)
        const tray = plan.trays.get(node.id)
        const head =
          territoryHeadroom(node) + (tray ? tray.h + TRAY.below : 0) + flowEntry(node, flow)
        return {
          id: node.id,
          role: spec.role,
          // El editor manda sobre el alto: si no cabe, el campo se recorta y su puerto cae fuera.
          // Un valor suelto (que no cabe en ninguna cajita) es una píldora, no una tarjeta.
          size: node.viewer
            ? viewerSize(node.viewer)
            : isChipKind(node)
              ? chipSize(node)
              : node.gist && !node.contains?.some((id) => present.has(id))
                ? // Plegada, una función de la que se sabe qué hace es su tarjeta «Qué hace».
                  gistSize(
                    titledScene(node.gist, {
                      ...(node.section ? { stage: node.section.title } : {}),
                      ...(node.note ? { note: node.note } : {}),
                    }),
                  )
                : node.section && !node.contains?.some((id) => present.has(id))
                  ? // Plegada, una etapa es su tarjeta; abierta, el marco la hace crecer con lo que tiene dentro.
                    sectionCardSize({
                      title: node.section.title,
                      subtitle: node.section.subtitle,
                      uses: node.section.uses,
                      leaves: node.section.leaves.map((leaf) => leaf.name),
                      callees: node.section.opens.map((open) => open.name),
                      glyphs: node.section.glyphs.length,
                      // Como módulo de la arquitectura se dice con palabras: se lee de lejos.
                      plain: flow && architecture?.modules.some((module) => module.id === node.id),
                    })
                  : flow && isDecision(node)
                    ? // Leída como diagrama de flujo, una decisión es su pregunta y, debajo, el rombo de la bifurcación.
                      widen(questionSize(node.control, d, node.label, node.code), node)
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
                            // Lo que abre (el chevron de una llamada, o las pastillas de sus subprocesos).
                            subprocessesOf(node).length > 0
                              ? opensWidth(subprocessesOf(node))
                              : node.openable
                                ? 26
                                : 0,
                          ),
                          h: lineHeight(node.note),
                        }
                      : d === 'normal'
                        ? // La tarjeta esbelta mide lo que lleva dentro, ni más ni menos.
                          widen(
                            {
                              w: slimWidth(base.w, node.control),
                              h: slimHeight(
                                node.control,
                                linked[node.id],
                                node.note,
                                node.code !== undefined,
                              ),
                            },
                            node,
                          )
                        : {
                            w: base.w,
                            h: base.h + extraHeight(node.control, d, linked[node.id], node.note),
                          },
          // La documentación, el editor de un bucle y la cajita de chips viven en la cabecera de un territorio.
          ...(head > 0 ? { headroom: head } : {}),
          ...(flowFoot(node, flow) > 0 ? { footroom: flowFoot(node, flow) } : {}),
          ...(tray ? { headerWidth: tray.w } : {}),
          // Un bucle con cuerpo envuelve lo que repite, igual que una función.
          ...(isTerritory(node) ? { territory: true } : {}),
          ...(node.contains && resized[node.id] ? { minSize: resized[node.id] } : {}),
          ...(node.contains ? { contains: node.contains } : {}),
          // De qué camino es cada paso: el diagrama de flujo lo necesita para saber dónde se juntan.
          ...(node.owner === undefined ? {} : { owner: node.owner }),
        }
      }),
      // Como diagrama de flujo, solo el orden coloca el plano: los datos van en chips, no en cables.
      edges: flow ? plan.flowEdges.filter((edge) => channelOf(edge) === 'control') : plan.flowEdges,
    }
    return layout(graph, {
      axis,
      ...(gapX === undefined ? {} : { gapX }),
      ...(gapY === undefined ? {} : { gapY }),
      // Una lista de pasos que se lee hacia abajo no se pliega en columnas: se recorre.
      ...(axis === 'vertical' ? { maxRun: 0 } : run === undefined ? {} : { maxRun: run }),
      // Las filas de módulos miden lo que cabe a un tamaño que se lea, sin contar lo que va al margen.
      ...(flow && architecture
        ? {
            architecture,
            ...(archRun === undefined ? {} : { architectureWidth: archRun }),
            ...(archFrame === undefined ? {} : { architectureFrame: archFrame }),
            ...(tailSize === undefined ? {} : { architectureTail: tailSize }),
            ...(gateSize === undefined ? {} : { architectureGate: gateSize }),
          }
        : {}),
    })
  }, [
    plan,
    densityOf,
    axis,
    flow,
    gapX,
    gapY,
    linked,
    resized,
    run,
    architecture,
    archRun,
    archFrame,
    tailSize,
    gateSize,
  ])

  /**
   * La procedencia a demanda: al seleccionar un nodo se dibujan sus cables ocultos (de dónde le llegan
   * los valores y a quién los da). Solo entre nodos que tienen puertos; un chip de una cajita o de un
   * bucle no los tiene, y a esos se les marcan las casillas.
   */
  const revealed = useMemo(() => {
    const shown = new Set<SemanticEdge>()
    // En un diagrama de flujo no hay cables de datos que revelar: la selección marca las casillas de sus chips.
    if (selectedId === null || flow) return shown
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
  }, [selectedId, plan, byId, flow])

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
  const dataPairs = useMemo(
    () =>
      new Set(
        edges
          .filter(
            (edge) =>
              edge.relation !== 'sequence' &&
              edge.relation !== 'feedback' &&
              !plan.hidden.has(edge) &&
              !plan.docked.has(edge.from),
          )
          .map((edge) => `${edge.from}|${edge.to}`),
      ),
    [edges, plan],
  )
  const flowIds = useMemo(() => new Set(plan.flowNodes.map((node) => node.id)), [plan])
  const visibleEdges = useMemo(
    () =>
      flow
        ? // Un diagrama de flujo solo dibuja la secuencia: el orden, las ramas, los saltos (`break`,
          // `continue`) y los retornos que no dibuja el propio bucle. Nunca un dato.
          [
            ...edges.filter(
              (edge) => edge.relation !== 'sequence' && channelOf(edge) === 'control',
            ),
            ...plan.order,
          ].filter(
            (edge) =>
              flowIds.has(edge.from) &&
              flowIds.has(edge.to) &&
              // La entrada de un territorio a su propio cuerpo la dice el espacio (y su carril). Lo que
              // vuelve a empezar sí se dibuja: llega al carril del bucle.
              !scopes[edge.from]?.includes(edge.to),
          )
        : // El orden de ejecución no se dibuja: en un bloque lineal ya lo dice la posición. Solo se ve, junto
          // con los cables ocultos, al seleccionar un nodo.
          [...edges.filter((edge) => edge.relation !== 'sequence'), ...plan.order].filter(
            (edge) => {
              // Leído hacia abajo el orden sí se dibuja (es lo que hace legible la secuencia), salvo entre dos
              // nodos que ya se unen por un dato: iría por el mismo camino.
              if (edge.relation === 'sequence') {
                return revealed.has(edge) || (aside && !dataPairs.has(`${edge.from}|${edge.to}`))
              }
              // Un valor que llega a un nodo que ya lo nombra (una constante, la variable de un bucle, un
              // parámetro, el resultado de otra línea) no se dibuja como cable: es un chip en su casilla.
              if (plan.docked.has(edge.from) || (plan.hidden.has(edge) && !revealed.has(edge))) {
                return false
              }
              // El retorno de un bucle territorio lo dibuja el propio bucle (su carril de repetición).
              if (edge.relation === 'feedback' && scopes[edge.to]?.includes(edge.from)) return false
              return edge.fromPort?.startsWith('param:') || !scopes[edge.from]?.includes(edge.to)
            },
          ),
    [edges, scopes, plan, revealed, aside, dataPairs, flow, flowIds],
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
  // Como arquitectura, la cajita de variables y funciones del programa no se enseña: repite, con sus nombres
  // en código, lo que ya dicen los módulos, y le quita al diagrama un tercio del ancho.
  const asArchitecture = flow && architecture !== null && figures !== undefined
  const moduleTray = asArchitecture ? undefined : plan.trays.get(MODULE)
  // Los pasos van por el centro. A la izquierda, lo auxiliar (la cajita de variables y los visores); a la
  // derecha, las notas. Leído en horizontal, la cajita va arriba y el resto del plano baja lo que ocupa.
  const sideW = aside
    ? Math.max(
        moduleTray?.w ?? 0,
        ...sideViewers.map((node) => (node.viewer ? viewerSize(node.viewer).w : 0)),
      )
    : 0
  const shiftX = aside && sideW > 0 ? sideW + MODULE_TRAY_AT.x + SIDE_GAP : 0
  const shiftY = !aside && moduleTray ? moduleTray.h + 24 : 0
  /** Hasta dónde llega el diagrama; a partir de ahí, el margen de las notas. */
  // El resultado, si lo hay, va a la cola de la arquitectura: a su derecha o, si así se ve más grande en
  // este lienzo, debajo. El encuadre le deja su sitio.
  const resultSize = useMemo(
    () => (result && figures !== undefined ? viewerSize(result.content) : null),
    [result, figures],
  )
  const resultSide = resultSize ? tailSide(layoutBounds, resultSize, archFrame) : 'right'
  const resultReserve = resultSize && resultSide === 'right' ? TAIL_GAP.x + resultSize.w : 0
  const resultBelow = resultSize && resultSide === 'bottom' ? TAIL_GAP.y + resultSize.h : 0
  const diagramW =
    (aside
      ? shiftX + layoutBounds.w
      : Math.max(layoutBounds.w, moduleTray ? moduleTray.w + MODULE_TRAY_AT.x * 2 : 0)) +
    resultReserve
  // Con notas, el margen cuenta para el encuadre: el zoom es el mismo llegue la nota que llegue.
  const noteReserve = noteNodes.length > 0 ? NOTE_GUTTER + NOTE.width + 24 : 0
  const bounds = useMemo(
    () => ({
      // Un salto que sale de un bucle (`break`) baja por su derecha: el encuadre le deja sitio.
      w: diagramW + noteReserve + (flow ? FLOW_LANE + 8 : 0),
      h:
        Math.max(
          layoutBounds.h + shiftY,
          aside && moduleTray ? moduleTray.h + MODULE_TRAY_AT.y * 2 : 0,
        ) + resultBelow,
    }),
    [diagramW, noteReserve, layoutBounds.h, shiftY, aside, moduleTray, flow, resultBelow],
  )

  const motionItems = useMemo(
    () =>
      placements.map((placement) => ({
        id: placement.id,
        value: placement,
        position: moved[placement.id] ?? { x: placement.x + shiftX, y: placement.y + shiftY },
      })),
    [placements, moved, shiftX, shiftY],
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
      // El título de una etapa (o de un bucle que encabeza una) es su rótulo: se reescribe el comentario.
      const section = byId.get(id)?.section
      if (edit.type === 'rename' && section) {
        onAction?.({ type: 'retitle', id: section.id, title: edit.to })
      } else if (edit.type === 'open-code') setCodeFor({ key: fitKey, id })
      else if (edit.type === 'rename')
        onAction?.({ type: 'rename', id, to: edit.to, ...(edit.from ? { from: edit.from } : {}) })
      else onAction?.({ type: edit.type, id })
    },
    [fitKey, onAction, byId],
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
      if (byId.get(to)?.kind === 'space.section') {
        setNotice('Una etapa no se mueve con un cable de orden: mueve sus sentencias.')
        return
      }
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
    // Una etapa no es una sentencia: se renombra, se pliega o se abre, y se quita (su código se queda).
    if (node.kind === 'space.section') {
      const section = node.section
      const own: NodeMenuItem[] = []
      if (onAction && section) {
        own.push({
          label: 'Renombrar la etapa',
          onSelect: () => {
            setRenaming((previous) => ({ id, n: previous.n + 1 }))
          },
        })
      }
      if (onEnter) {
        own.push({
          label: scopes[id] ? 'Plegar la etapa' : 'Abrir la etapa',
          onSelect: () => {
            onEnter(id)
          },
        })
      }
      if (onAction && section) {
        own.push({
          label: 'Quitar la etapa (el código se queda)',
          onSelect: () => {
            onAction({ type: 'unsection', id: section.id })
          },
        })
      }
      return own
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
        label: node.section ? 'Renombrar la etapa' : 'Renombrar',
        onSelect: () => {
          setRenaming((previous) => ({ id, n: previous.n + 1 }))
        },
      })
    }
    // Un bucle que encabeza una etapa: la etapa se puede quitar (el bucle se queda).
    const merged = node.section
    if (merged && onAction) {
      items.push({
        label: 'Quitar la etapa (el código se queda)',
        onSelect: () => {
          onAction({ type: 'unsection', id: merged.id })
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
    // Partir su bloque en etapas: esta sentencia empieza una (el rótulo se escribe encima).
    if (onAction && flow && node.line !== undefined && !merged) {
      items.push({
        label: 'Empezar una etapa aquí',
        onSelect: () => {
          onAction({ type: 'section', id, title: 'Nueva etapa', first: 'Primera etapa' })
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

  /**
   * Mover un extremo de un cable ya tendido. El destino a otra casilla: la de antes vuelve a un valor
   * neutro y la nueva lee el nombre (una sola edición). El origen a otro nodo: la casilla pasa a leer el
   * nombre del nuevo. Soltado en el vacío: el cable se quita, como con Supr.
   */
  const reconnected = useRef(false)
  const cableOf = useCallback(
    (edge: { id: string }) => visibleEdges.find((candidate) => edgeKey(candidate) === edge.id),
    [visibleEdges],
  )
  const onReconnect = useCallback(
    (old: PryselFlowEdge, connection: Connection) => {
      reconnected.current = true
      const was = cableOf(old)
      if (!was || was.toPort === undefined || isOrderHandle(connection.sourceHandle)) return
      const link = linkOf(connection)
      const verdict = checkConnection(lookup, link)
      if (!verdict.ok) {
        setNotice(verdict.reason)
        return
      }
      onAction?.({
        type: 'reconnect',
        was: { id: was.to, slot: was.toPort },
        from: link.from,
        ...(link.port ? { port: link.port } : {}),
        to: link.to,
        slot: link.slot,
        ...(verdict.convert ? { convert: verdict.convert } : {}),
      })
      if (verdict.convert) setNotice(convertNotice(verdict.name))
      setEdgeState(null)
    },
    [cableOf, linkOf, lookup, onAction, setEdgeState],
  )
  const onReconnectEnd = useCallback(
    (
      _: MouseEvent | TouchEvent,
      edge: PryselFlowEdge,
      _fixed: unknown,
      state: FinalConnectionState,
    ) => {
      setConnecting(null)
      if (reconnected.current) {
        reconnected.current = false
        return
      }
      const was = cableOf(edge)
      if (!was) return
      if (!state.toNode) disconnect(was)
      else setNotice('Suelta el extremo sobre el puerto de un campo donde valga ese valor.')
    },
    [cableOf, disconnect],
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
    } else if (
      selectedId !== null &&
      byId.has(selectedId) &&
      scopes[selectedId] === undefined &&
      // Una etapa no se borra con una tecla: su menú la quita (y su código se queda).
      byId.get(selectedId)?.kind !== 'space.section'
    ) {
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

  /** El «+» bajo un paso: se ofrece lo que se puede crear justo después, ahí donde se pulsó. */
  const onAddAfter = useCallback((id: string, at: { x: number; y: number }) => {
    const frame = frameRef.current?.getBoundingClientRect()
    if (!frame) return
    setMenu(null)
    setQuick(null)
    setOrderAdd({ from: id, port: 'order-out', x: at.x - frame.left + 12, y: at.y - frame.top })
  }, [])

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
      echoed: echo?.includes(node.id) === true,
      born: spotlight?.id === node.id && spotlight.born === true,
      change: spotlight?.id === node.id ? spotlight.change : undefined,
      hinted: hinted?.has(node.id) === true,
      // En el diagrama de flujo es un paso más: la secuencia entra por arriba y sale por abajo.
      ...(flow ? { step: true } : {}),
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

  /** El papel de cada módulo de la arquitectura, cuando el plano se colocó con ella. */
  const roleOf: Record<string, ModuleRole> =
    architecture && figures !== undefined
      ? Object.fromEntries(architecture.modules.map((module) => [module.id, module.role]))
      : {}
  /**
   * Los módulos cuyos datos usan tres o más de los demás, y cuántos: sus flechas no se dibujan todas a la vez
   * (ver `archEdges`). Quien ancla la forma no cuenta: sus flechas son la forma.
   */
  const sharedBy: Record<string, number> = {}
  if (architecture && figures !== undefined) {
    for (const module of architecture.modules) {
      if (module.id === architecture.anchor) continue
      const users = new Set(
        architecture.links
          .filter((link) => link.kind === 'data' && link.told !== true && link.from === module.id)
          .map((link) => link.to),
      )
      if (users.size >= SHARED_FROM) sharedBy[module.id] = users.size
    }
  }
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
          modifier: modifierOf?.(node.id),
          axis,
          size: item.value.size,
          container,
          // Leído como diagrama de flujo, por dónde entra y sale la secuencia de un territorio.
          ...(container && spines?.[node.id] !== undefined ? { spine: spines[node.id] } : {}),
          renameSignal: renaming.id === node.id ? renaming.n : 0,
          // En la arquitectura, el papel del módulo: su icono y su tinte.
          ...(roleOf[node.id] === undefined ? {} : { role: roleOf[node.id] }),
          ...(sharedBy[node.id] === undefined ? {} : { usedBy: sharedBy[node.id] }),
          showStatus,
          linkedSlots: linked[node.id] ?? [],
          connectable,
          eligible: eligible ? (eligible[node.id] ?? []) : null,
          // Al arrastrar un nodo: la función que lo recibiría, y la que lo perdería.
          drop: reparent?.to === node.id ? 'into' : reparent?.from === node.id ? 'out' : undefined,
          addTarget: addTarget === node.id,
          cursor: cursor === node.id,
          spotlit: spotlight?.id === node.id ? spotlight.key : undefined,
          echoed: echo?.includes(node.id) === true,
          born: spotlight?.id === node.id && spotlight.born === true,
          change: spotlight?.id === node.id ? spotlight.change : undefined,
          hinted: hinted?.has(node.id) === true,
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
          ...(flow && connectable ? { onAddAfter } : {}),
          phase: item.phase,
          ...(onControlChange ? { onControlChange: changeControl } : {}),
          ...(onAction ? { onNodeEdit } : {}),
          ...(onEnter ? { onEnter } : {}),
          ...(onOpen ? { onOpen } : {}),
          ...(onGistEdit ? { onGistEdit } : {}),
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
      if (context === MODULE && asArchitecture) continue
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
            // Doble clic en el chip de una función: se va a su definición.
            ...(fn && onOpen ? { onOpen } : {}),
            // La cajita en columna numera sus chips como los pasos: la línea en la que se definen.
            ...(aside && context === MODULE && (chip?.line ?? fn?.line) !== undefined
              ? { line: chip?.line ?? fn?.line }
              : {}),
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
            echoed: echo?.includes(placed.id) === true,
            born: spotlight?.id === placed.id && spotlight.born === true,
            change: spotlight?.id === placed.id ? spotlight.change : undefined,
            hinted: hinted?.has(placed.id) === true,
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
  /** Un cable de datos que llega a una casilla: se puede soltar (Supr) y mover por sus extremos. */
  const removableCable = (edge: SemanticEdge): boolean =>
    connectable &&
    edge.toPort !== undefined &&
    (edge.toPort !== 'return' || edge.via !== undefined) &&
    byId.get(edge.to)?.inputs?.includes(edge.toPort) === true
  // ── El diagrama de flujo: por dónde sale cada paso y cómo se juntan los caminos ──
  const boxOf = new Map(animated.map((item) => [item.id, { ...item.position, ...item.value.size }]))
  /**
   * Por dónde baja un camino que tiene que rodear lo que queda debajo de un paso (el «no» de una decisión sin
   * `else`, un `continue`): a la derecha de todo lo que haya entre ese paso y `bottom`. Se mide con las
   * posiciones de ahora, así que sigue valiendo si el usuario mueve algo.
   */
  const laneBetween = (fromId: string, bottom: number): number | undefined => {
    const from = boxOf.get(fromId)
    if (!from) return undefined
    const right = from.x + from.w
    let lane = right
    for (const [id, box] of boxOf) {
      if (id === fromId) continue
      if (box.y < from.y + from.h - 1 || box.y + box.h > bottom + 1) continue
      if (box.x > right + 60 || box.x + box.w < from.x) continue
      lane = Math.max(lane, box.x + box.w)
    }
    return lane + FLOW_LANE
  }
  /** El bucle (dibujado como territorio) que es el destino de una conexión, si lo es. */
  const loopAt = (id: string) => {
    const node = byId.get(id)
    return node && scopes[id] !== undefined && isLoopTerritory(node) ? node : undefined
  }
  /**
   * El papel de cada conexión en el diagrama de flujo: de qué puerto sale y a cuál llega, por dónde se traza y
   * qué dice junto al vértice. `null` si no es parte de la secuencia.
   */
  const flowRole = (edge: SemanticEdge): FlowRole | null => {
    if (!flow) return null
    const from = byId.get(edge.from)
    const decision = from !== undefined && isDecision(from)
    const loop = loopAt(edge.to)
    // Vuelve a empezar: el final del cuerpo, el «no» de su última decisión o un `continue` llegan al carril.
    if (loop && (edge.relation === 'feedback' || edge.toPort === 'next')) {
      const box = boxOf.get(loop.id)
      const side = decision || edge.toPort === 'next'
      const lane = side && box ? laneBetween(edge.from, box.y + box.h - FLOW_RAIL) : undefined
      return {
        target: loop.id,
        sourceHandle: decision ? 'step-no' : side ? 'step-side' : 'step-out',
        targetHandle: 'rail-in',
        exit: side ? 'right' : 'bottom',
        ...(lane === undefined ? {} : { lane }),
        ...(decision ? { tag: 'no' } : {}),
        // Llega por el fondo, a la altura del carril: se funde con él en vez de entrar desde arriba.
        bend: 0,
      }
    }
    // Un `break` sale del bucle: rodea su territorio por la derecha y llega a lo que sigue al bucle (que no
    // es su `else`: ese solo se hace al acabar sin salir). Si no sigue nada, sale por la derecha hacia abajo.
    if (loop && edge.toPort === 'exit') {
      const box = boxOf.get(loop.id)
      if (!box) return null
      const successor = (id: string) => plan.order.find((candidate) => candidate.from === id)?.to
      let after = successor(loop.id)
      if (after !== undefined && byId.get(after)?.kind === 'control.clause')
        after = successor(after)
      return {
        target: after ?? loop.id,
        sourceHandle: 'step-side',
        targetHandle: after === undefined ? 'exit' : 'step-in',
        exit: 'right',
        lane: box.x + box.w + FLOW_LANE,
      }
    }
    if (!isStep(edge)) return null
    // El «no» de una decisión: su rama falsa, o lo que la sigue si no tiene `else`.
    const no =
      decision &&
      (edge.relation === 'sequence' || (edge.relation === 'branch' && edge.label === 'falso'))
    const to = boxOf.get(edge.to)
    const fromBox = boxOf.get(edge.from)
    // Un destino a la derecha (el `else`, un `elif`) se alcanza sin rodear nada; si vuelve a la espina, rodea.
    const around =
      no &&
      to !== undefined &&
      fromBox !== undefined &&
      to.x + to.w / 2 <= fromBox.x + fromBox.w + 12
    const lane = around && to ? laneBetween(edge.from, to.y) : undefined
    return {
      target: edge.to,
      sourceHandle: no ? 'step-no' : 'step-out',
      targetHandle: 'step-in',
      exit: no ? 'right' : 'bottom',
      ...(lane === undefined ? {} : { lane }),
      ...(no ? { tag: 'no' } : edge.relation === 'branch' ? { tag: 'sí' } : {}),
    }
  }
  // ── La arquitectura: el primer nivel son módulos unidos por lo que se pasan y por quién usa a quién ──
  /** Los módulos que el plano colocó según su forma (si lo hizo). */
  const archModules = new Map(
    architecture && figures !== undefined
      ? architecture.modules.flatMap((module) =>
          boxOf.has(module.id) && parentOf[module.id] === undefined ? [[module.id, module]] : [],
        )
      : [],
  )
  // Entre módulos no hay una espina que baje: el orden se lee en su número, y lo que los une, en sus flechas.
  const drawnEdges =
    archModules.size === 0
      ? visibleEdges
      : visibleEdges.filter(
          (edge) =>
            !(
              (archModules.has(edge.from) || archModules.has(edge.to)) &&
              parentOf[edge.from] === undefined &&
              parentOf[edge.to] === undefined
            ),
        )
  // Cada dato que viaja, con su color: el mismo en todas las flechas por las que pasa.
  const hues = flowHues(archModules.size > 0 && architecture ? architecture.links : [])
  const archEdges: ArchFlowEdge[] = (
    archModules.size > 0 && architecture ? architecture.links : []
  ).flatMap((link, at, links) => {
    const from = archModules.has(link.from) ? boxOf.get(link.from) : undefined
    const to = archModules.has(link.to) ? boxOf.get(link.to) : undefined
    if (!from || !to) return []
    // Lo que usan casi todos (los datos del programa) no tiende una flecha a cada uno: sería una maraña que
    // no dice más que la pastilla que ya lleva cada módulo. Se dice en el propio módulo, y sus flechas salen
    // al seleccionarlo (o al seleccionar a quien lo usa).
    if (
      link.kind === 'data' &&
      link.told !== true &&
      (sharedBy[link.from] ?? 0) > 0 &&
      !(lit?.has(link.from) || lit?.has(link.to))
    ) {
      return []
    }
    // Dos flechas entre los mismos dos módulos se comban cada una hacia un lado, para no pisarse.
    const twins = links.filter(
      (other) =>
        (other.from === link.from && other.to === link.to) ||
        (other.from === link.to && other.to === link.from),
    )
    const same = twins.filter((other) => other.from === link.from)
    const prefer = twins.length < 2 ? 0 : same.indexOf(link) % 2 === 0 ? 22 : -22
    // …y ninguna pasa por encima de otro módulo: se comba lo justo para rodearlo.
    const others = [...archModules.keys()].flatMap((id) => {
      const box = id === link.from || id === link.to ? undefined : boxOf.get(id)
      return box ? [box] : []
    })
    const bend = clearBend(from, to, others, prefer)
    const touched = lit ? lit.has(link.from) || lit.has(link.to) : null
    const hue = link.kind === 'data' && link.label ? hues.get(flowName(link.label)) : undefined
    const live = beat?.links.includes(`${link.from}>${link.to}`) === true
    return [
      {
        id: `arch:${link.kind}:${link.from}:${link.to}`,
        source: link.from,
        target: link.to,
        sourceHandle: 'note-out',
        targetHandle: 'step-in',
        type: 'arch' as const,
        selectable: false,
        focusable: false,
        ...(link.label === undefined ? {} : { label: link.label }),
        zIndex: touched || live ? 10 : 2,
        data: {
          kind: link.kind,
          from,
          to,
          bend,
          turn: at,
          ...(live && beat ? { live: beat.serial, ms: beat.ms } : {}),
          ...(hue === undefined ? {} : { hue }),
          ...(link.planned ? { planned: true } : {}),
          ...(touched === null
            ? {}
            : { emphasis: touched ? ('active' as const) : ('dim' as const) }),
        },
      },
    ]
  })
  // ── El resultado y el arranque: los dos extremos de la arquitectura ──
  const resultAt =
    resultSize && archModules.size > 0
      ? resultSide === 'bottom'
        ? {
            x: shiftX + Math.max(28, (layoutBounds.w - resultSize.w) / 2),
            y: shiftY + layoutBounds.h - 28 + TAIL_GAP.y,
            ...resultSize,
          }
        : {
            x: shiftX + layoutBounds.w + TAIL_GAP.x - 28,
            y: shiftY + Math.max(28, (layoutBounds.h - resultSize.h) / 2),
            ...resultSize,
          }
      : null
  const resultNodes: ViewerFlowNode[] =
    result && resultAt
      ? [
          {
            ...viewerNode(
              RESULT_NODE,
              result.content,
              { x: resultAt.x, y: resultAt.y },
              { w: resultAt.w, h: resultAt.h },
            ),
            draggable: false,
            selectable: false,
            // No es un visor que se haya fijado: no se quita.
            data: { node: RESULT_NODE, content: result.content, size: resultAt },
          },
        ]
      : []
  // Quién escribe el resultado le tiende una flecha… salvo en un ciclo con su compuerta de salida: ahí el
  // resultado llega «al salir», y esa es la única flecha que lo dice (la de quien lo escribe, que está fuera
  // de la vuelta, tendría que cruzar el anillo para decir lo mismo).
  const viaGate =
    exit !== null &&
    archModules.has(exit.at) &&
    figures?.some((figure) => figure.kind === 'gate') === true &&
    architecture?.order !== undefined &&
    result !== null &&
    !result.from.some((id) => architecture.order?.includes(id))
  const resultEdges: ArchFlowEdge[] = (result && resultAt && !viaGate ? result.from : []).flatMap(
    (id, at) => {
      const from = archModules.has(id) ? boxOf.get(id) : undefined
      if (!from || !resultAt) return []
      const others = [...archModules.keys()].flatMap((other) => {
        const box = other === id ? undefined : boxOf.get(other)
        return box ? [box] : []
      })
      return [
        {
          id: `arch:result:${id}`,
          source: id,
          target: RESULT_ID,
          sourceHandle: 'note-out',
          targetHandle: 'in',
          type: 'arch' as const,
          selectable: false,
          focusable: false,
          label: result?.planned ? 'daría' : 'enseña',
          zIndex: 2,
          data: {
            kind: 'data' as const,
            from,
            to: resultAt,
            bend: clearBend(from, resultAt, others, 0),
            turn: at,
            ...(beat?.links.includes(`${id}>${RESULT_ID}`)
              ? { live: beat.serial, ms: beat.ms }
              : {}),
            ...(result?.planned ? { planned: true } : {}),
          },
        },
      ]
    },
  )
  const startBox = start && archModules.has(start.at) ? boxOf.get(start.at) : undefined
  const startFigures: Figure[] = startBox
    ? [
        {
          id: 'start',
          kind: 'start',
          x: startBox.x - shiftX + 14,
          y: startBox.y - shiftY - 26,
          w: 200,
          h: 22,
          label: start?.label ?? '',
        },
      ]
    : []
  // La compuerta de salida del ciclo: el plano le hizo sitio junto a quien lo lleva. Es un nodo más: le
  // llega la flecha de la cabeza («no hay otra vuelta») y de ella sale la que va al resultado, salvo que el
  // resultado lo escriba la propia vuelta (entonces no es «al salir» cuando aparece).
  const gateFigure =
    exit && archModules.has(exit.at) ? figures?.find((figure) => figure.kind === 'gate') : undefined
  const gateBox = gateFigure
    ? { x: gateFigure.x + shiftX, y: gateFigure.y + shiftY, w: gateFigure.w, h: gateFigure.h }
    : undefined
  const exitFrom = exit && gateBox ? boxOf.get(exit.at) : undefined
  const turning = new Set(architecture?.order ?? [])
  const exitLeads =
    result !== null && resultAt !== null && !result.from.some((id) => turning.has(id))
  const moduleBoxes = [...archModules.keys()].flatMap((id) => boxOf.get(id) ?? [])
  const exitLive = beat?.at === RESULT_ID ? { live: beat.serial, ms: beat.ms } : {}
  const exitEdges: ArchFlowEdge[] =
    exit && gateBox && exitFrom
      ? [
          {
            id: 'arch:exit:in',
            source: exit.at,
            target: 'figure:gate',
            sourceHandle: 'note-out',
            targetHandle: 'in',
            type: 'arch' as const,
            selectable: false,
            focusable: false,
            zIndex: 2,
            data: { kind: 'next' as const, from: exitFrom, to: gateBox, bend: 0, ...exitLive },
          },
          ...(exitLeads && resultAt
            ? [
                {
                  id: 'arch:exit:out',
                  source: 'figure:gate',
                  target: RESULT_ID,
                  sourceHandle: 'out',
                  targetHandle: 'in',
                  type: 'arch' as const,
                  selectable: false,
                  focusable: false,
                  zIndex: 2,
                  data: {
                    kind: 'next' as const,
                    from: gateBox,
                    to: resultAt,
                    bend: clearBend(gateBox, resultAt, moduleBoxes, 0),
                    ...(result?.planned ? { planned: true } : {}),
                    ...exitLive,
                  },
                },
              ]
            : []),
        ]
      : []
  // Las pastillas de las flechas, cada una donde no tape a nadie: ni a un módulo, ni a una marca (la de
  // arranque, la de salida), ni a otra pastilla ya puesta.
  const labelObstacles: { x: number; y: number; w: number; h: number }[] = [
    ...moduleBoxes,
    ...(gateBox ? [gateBox] : []),
    ...startFigures.map((figure) => ({
      x: figure.x + shiftX,
      y: figure.y + shiftY,
      // La marca mide lo que su texto, no lo que su hueco.
      w: Math.min(figure.w, (figure.label?.length ?? 0) * 6.4 + 34),
      h: figure.h,
    })),
  ]
  const labelledEdges: ArchFlowEdge[] = archEdges.map((edge) => {
    const text = typeof edge.label === 'string' ? edge.label : ''
    if (text === '' || !edge.data) return edge
    const size = labelSize(text)
    const { from, to, bend = 0 } = edge.data
    const labelAt = labelSpot(from, to, bend, size, labelObstacles)
    const { mid } = archPath(from, to, bend, labelAt)
    labelObstacles.push({ x: mid.x - size.w / 2, y: mid.y - size.h / 2, ...size })
    return labelAt === 0.5 ? edge : { ...edge, data: { ...edge.data, labelAt } }
  })
  // Al reproducir: el marco de «ahora está aquí», alrededor del módulo (o del resultado) al que se llega.
  const spotBox = !beat
    ? undefined
    : beat.at === RESULT_ID
      ? (resultAt ?? undefined)
      : archModules.has(beat.at)
        ? boxOf.get(beat.at)
        : undefined
  const SPOT_AIR = 7
  const spotFigures: Figure[] = spotBox
    ? [
        {
          id: 'spot',
          kind: 'spot',
          x: spotBox.x - shiftX - SPOT_AIR,
          y: spotBox.y - shiftY - SPOT_AIR,
          w: spotBox.w + SPOT_AIR * 2,
          h: spotBox.h + SPOT_AIR * 2,
        },
      ]
    : []
  /** Las figuras de fondo que dicen la forma: van detrás de todo y no se tocan. */
  const figureNodes: FigureFlowNode[] = (
    archModules.size > 0
      ? [
          // La compuerta solo se dibuja si hay salida que contar; y lleva su texto.
          ...(figures ?? []).flatMap((figure) =>
            figure.kind !== 'gate'
              ? [figure]
              : gateFigure
                ? [{ ...figure, label: exit?.label ?? '' }]
                : [],
          ),
          ...startFigures,
          ...spotFigures,
        ]
      : []
  ).map((figure) => ({
    id: `figure:${figure.id}`,
    type: 'figure' as const,
    position: { x: figure.x + shiftX, y: figure.y + shiftY },
    ...nodeFrame({ w: figure.w, h: figure.h }),
    // Las marcas van por delante: se apoyan en el borde de su módulo.
    zIndex: figure.kind === 'start' || figure.kind === 'gate' || figure.kind === 'spot' ? 6 : -1,
    ...(figure.kind === 'spot' ? { className: 'arch-spot-node' } : {}),
    draggable: false,
    selectable: false,
    focusable: false,
    style: { pointerEvents: 'none' as const },
    data: { figure },
  }))

  const roles = new Map(drawnEdges.map((edge) => [edge, flowRole(edge)]))
  /** Cuántos caminos llegan a cada punto: si son varios, se juntan en un punto justo encima de él. */
  const arriving = new Map<string, number>()
  for (const role of roles.values()) {
    if (!role) continue
    const key = `${role.target}:${role.targetHandle}`
    arriving.set(key, (arriving.get(key) ?? 0) + 1)
  }

  const flowEdges: PryselFlowEdge[] = drawnEdges.map((edge) => {
    const role = roles.get(edge) ?? null
    const step = role !== null
    return {
      id: edgeKey(edge),
      selected: edgeId === edgeKey(edge),
      source: edge.from,
      target: role?.target ?? edge.to,
      // En compacto un nodo no tiene casillas (ni puertos por campo): todo entra y sale por el borde.
      // Un resultado entre varios es un chip: su cable, si se dibuja, sale por el puerto normal.
      // Leída hacia abajo, la secuencia sale por el centro de cada paso y entra por el centro del siguiente; el
      // «no» de una decisión, por el vértice derecho de su rombo.
      sourceHandle: role
        ? role.sourceHandle
        : aside && edge.relation === 'sequence'
          ? 'step-out'
          : edge.fromPort && !edge.fromPort.startsWith('result:') && !isCompact(edge.from)
            ? edge.fromPort
            : 'out',
      targetHandle: role
        ? role.targetHandle
        : aside && edge.relation === 'sequence'
          ? 'step-in'
          : edge.toPort && !isCompact(edge.to)
            ? edge.toPort
            : 'in',
      type: 'prysel' as const,
      // Un cable de datos que se puede soltar también se puede mover por sus extremos (no el de un
      // `return` que el lienzo se salta: ese se quita, no se mueve).
      reconnectable: removableCable(edge) && edge.via === undefined,
      // En el diagrama de flujo, «sí» y «no» van junto al vértice del que salen (no en medio del camino).
      ...(edge.label === undefined || step ? {} : { label: edge.label }),
      markerEnd:
        step || (aside && edge.relation === 'sequence')
          ? 'url(#prysel-arrow-spine)'
          : `url(#prysel-arrow-${channelOf(edge) === 'control' ? 'thick' : 'thin'})`,
      // Con algo seleccionado, sus conexiones destacan y el resto se retira.
      ...(lit ? { zIndex: lit.has(edge.from) || lit.has(edge.to) ? 10 : 0 } : {}),
      data: {
        relation: edge.relation,
        channel: channelOf(edge),
        obstacles,
        parentOf,
        axis,
        ...(removableCable(edge)
          ? {
              removable: true,
              onRemove: () => {
                disconnect(edge)
              },
            }
          : {}),
        ...(lit ? { emphasis: lit.has(edge.from) || lit.has(edge.to) ? 'active' : 'dim' } : {}),
        live:
          stateOf !== undefined &&
          stateOf(edge.from) === 'success' &&
          stateOf(edge.to) !== 'dormant',
        ...(role
          ? {
              flow: {
                exit: role.exit,
                ...(role.lane === undefined ? {} : { lane: role.lane }),
                join: (arriving.get(`${role.target}:${role.targetHandle}`) ?? 0) > 1,
                ...(role.bend === undefined ? {} : { bend: role.bend }),
                ...(role.tag === undefined ? {} : { tag: role.tag }),
              },
            }
          : {}),
      },
    }
  })

  /**
   * Las notas: cada una en el margen a la derecha del diagrama, a la altura de lo que explica, con su flecha
   * a mano. Las que aún no llegaron ocupan su sitio pero no se dibujan.
   */
  /** Dónde está cada nodo y cada chip ahora mismo: lo que las notas y los visores tienen al lado. */
  const anchorRects = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const flow of [...flowNodes, ...dockedNodes]) {
    const size = (flow.data as { size?: { w: number; h: number } }).size
    if (size) anchorRects.set(flow.id, { ...flow.position, ...size })
  }

  /**
   * Los visores fijados, a la izquierda del diagrama y a la altura de lo que enseñan (debajo de la cajita de
   * variables), con su cable. Como las notas, no entran en el reparto: no mueven nada.
   */
  const sideFlow = (() => {
    const nodesOut: ViewerFlowNode[] = []
    const edgesOut: PryselFlowEdge[] = []
    if (sideViewers.length === 0) return { nodes: nodesOut, edges: edgesOut }
    const linkOf = new Map(viewerLinks.map((link) => [link.to, link]))
    const slots: NoteSlot[] = []
    for (const node of sideViewers) {
      const anchor = anchorRects.get(linkOf.get(node.id)?.from ?? '')
      if (anchor && node.viewer) slots.push({ id: node.id, anchor, size: viewerSize(node.viewer) })
    }
    const top = moduleTray ? MODULE_TRAY_AT.y + moduleTray.h + 16 : -Infinity
    const placed = placeNotes(slots, MODULE_TRAY_AT.x, 14, top)
    for (const node of sideViewers) {
      const at = placed.get(node.id)
      const link = linkOf.get(node.id)
      if (!node.viewer || !at || !link) continue
      nodesOut.push({
        ...viewerNode(node, node.viewer, at, viewerSize(node.viewer)),
        data: {
          node,
          content: node.viewer,
          size: viewerSize(node.viewer),
          aside: true,
          ...(onUnpin ? { onUnpin } : {}),
        },
      })
      edgesOut.push({
        id: `viewer-${link.from}-${node.id}`,
        source: link.from,
        target: node.id,
        sourceHandle: 'aux-out',
        targetHandle: 'in',
        type: 'prysel' as const,
        markerEnd: 'url(#prysel-arrow-thin)',
        zIndex: 6,
        data: { relation: 'transform', channel: 'data', obstacles, parentOf, axis: 'horizontal' },
      })
    }
    return { nodes: nodesOut, edges: edgesOut }
  })()

  /** Dónde pondría el margen cada nota: el origen desde el que se mide lo que se aparta una arrastrada. */
  const notePlaced = useRef<ReadonlyMap<string, Point>>(NO_PLACED)
  const noteFlow = (() => {
    const nodesOut: NoteFlowNode[] = []
    const edgesOut: PryselFlowEdge[] = []
    if (noteNodes.length === 0) return { nodes: nodesOut, edges: edgesOut, placed: NO_PLACED }
    const rects = anchorRects
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
      // Donde la dejó quien la arrastró: mientras se arrastra, o ya soltada (hasta que el guion lo recoja),
      // manda lo del lienzo; si no, lo que dice el guion.
      const offset = content.offset
      const position =
        noteMoves[note.id] ?? (offset ? { x: at.x + offset.x, y: at.y + offset.y } : at)
      nodesOut.push({
        id: note.id,
        type: 'note' as const,
        position,
        ...nodeFrame(size),
        zIndex: 4,
        draggable: interactive && onNoteMove !== undefined,
        selectable: false,
        focusable: false,
        data: {
          note: content,
          size,
          moved: noteMoves[note.id] !== undefined || offset !== undefined,
          onHint: setHint,
          knows: knowsCode,
          ...(onNoteMove
            ? {
                onReset: () => {
                  setNoteMoves((previous) =>
                    Object.fromEntries(Object.entries(previous).filter(([id]) => id !== note.id)),
                  )
                  onNoteMove(note.id, null)
                },
              }
            : {}),
        },
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
          axis: 'horizontal',
        },
      })
    }
    return { nodes: nodesOut, edges: edgesOut, placed }
  })()
  // Dónde las puso el margen, para medir cuánto se aparta una nota arrastrada (se lee al soltarla).
  const placedNotes = noteFlow.placed
  useEffect(() => {
    notePlaced.current = placedNotes
  }, [placedNotes])

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
        // Una nota no entra en el reparto: se lleva a mano, y lo que se aparta se guarda en el guion al soltarla.
        if (noteIds.has(id)) {
          setNoteMoves((previous) => ({ ...previous, [id]: position }))
          continue
        }
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
    [descendantsOf, fitKey, isDockedChip, chipDrag, noteIds],
  )

  // Al cambiar el programa, el encuadre se rehace — salvo que el usuario ya lo haya movido.
  const avoidW = avoid?.w ?? 0
  const avoidH = avoid?.h ?? 0
  /** Se está viendo la arquitectura: el encuadre la enseña entera. */
  const picture = asArchitecture
  const shape = `${fitKey}|${bounds.w}x${bounds.h}:${placements.length}|${refits}|${settle}|${avoidW}x${avoidH}|${reserveTop}:${reserveBottom}|${picture}`
  const lastSettle = useRef(settle)
  /**
   * El encuadre lo calcula la propia gramática: ya sabe cuánto ocupa el programa, así que
   * no hace falta que la vista lo redescubra midiendo el DOM (que además llega tarde).
   */
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || taken) return
    // Lo que se construía ha terminado: la cámara deja de estar donde la llevó la orden y se enseña todo.
    const settled = lastSettle.current !== settle
    if (settled) {
      lastSettle.current = settle
      spotHeld.current = null
    }
    const fit = () => {
      // La cámara está donde la dejó una orden: no se la lleva un reencuadre.
      if (spotHeld.current === fitKey) return
      const pad = 24
      // Lo que hay para el diagrama: el lienzo, menos las franjas de las barras que flotan arriba y abajo y
      // el rincón que ocupe la consola (lo que sobresalga de la franja de abajo).
      const room = roomFor(
        { w: frame.clientWidth, h: frame.clientHeight - reserveTop - reserveBottom },
        bounds,
        avoidW > 0 && avoidH > reserveBottom ? { w: avoidW, h: avoidH - reserveBottom } : null,
        pad,
      )
      const byWidth = Math.max(0.15, (room.w - pad * 2) / bounds.w)
      const byHeight = Math.max(0.15, (room.h - pad * 2) / bounds.h)
      // Un lienzo de trabajo se ajusta al ancho y se recorre; una ilustración se enseña entera.
      const mode = fitMode ?? (interactive ? 'width' : 'contain')
      // Al asentarse, entero si se lee (no por debajo de un tamaño legible); si no, a lo ancho y desde arriba.
      const whole = Math.min(byWidth, byHeight)
      const zoom = Math.min(
        1,
        // Mientras se construye basta con ver el conjunto; al acabar, entero solo si se lee.
        mode === 'width'
          ? // La arquitectura es un dibujo que se ve de una vez (y se colocó para caber en este lienzo): entera,
            // salvo que entera ya no se lea.
            picture
            ? whole >= 0.35
              ? whole
              : byWidth
            : whole >= (follow ? 0.6 : 0.5) && (settled || !follow)
              ? whole
              : byWidth
          : whole,
      )
      const first = lastFit.current === ''
      lastFit.current = shape
      void setViewport(
        {
          x: (room.w - bounds.w * zoom) / 2,
          y: reserveTop + Math.max(pad, (room.h - bounds.h * zoom) / 2),
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
  }, [
    shape,
    taken,
    setViewport,
    animate,
    bounds.w,
    bounds.h,
    fitMode,
    interactive,
    fitKey,
    settle,
    follow,
    avoidW,
    avoidH,
    reserveTop,
    reserveBottom,
    picture,
  ])

  // El foco de una orden: la cámara va a donde el nodo **va a quedar** (no a donde está a medio camino de
  // su animación), a un tamaño que se lea. Desde ahí la cámara ya no se reencuadra sola: se movió a propósito.
  // Va después del encuadre: si los dos tocan a la vez (un nodo nuevo cambia el tamaño del diagrama), gana este.
  const spotDone = useRef('')
  useEffect(() => {
    const frame = frameRef.current
    const gesture = spotlight ? `${spotlight.key}:${spotlight.id}` : ''
    if (!frame || !spotlight || spotDone.current === gesture) return
    // Mientras se construye, la vista es la del conjunto: el gesto se da por hecho sin mover la cámara.
    if (!follow) {
      spotDone.current = gesture
      return
    }
    const target = spotlight.camera ?? spotlight.id
    const item = motionItems.find((entry) => entry.id === target)
    if (!item) return
    spotDone.current = gesture
    const { w, h } = item.value.size
    const margin = 64
    // Un territorio grande se enseña entero; un paso suelto, a tamaño de lectura.
    const room = Math.min(
      (frame.clientWidth - 2 * margin) / w,
      (frame.clientHeight - 2 * margin) / h,
    )
    // El zoom justo para lo que se explica: una pieza pequeña se acerca hasta ocupar un tercio del lienzo
    // (se lee sin esfuerzo); una grande se aleja lo que haga falta para verse entera. «En su conjunto»,
    // algo más lejos, para que quepa lo que la rodea.
    const reading = Math.min((frame.clientWidth * 0.5) / w, (frame.clientHeight * 0.34) / h)
    const close = Math.max(1, Math.min(MAX_SPOT_ZOOM, reading))
    // Un bloque que no cabe entero a un tamaño que se lea no se aleja hasta hacerse ilegible: se enseña
    // su cabecera (lo de arriba), a tamaño de lectura, y lo de dentro se irá enfocando pieza a pieza.
    const fits = room >= MIN_SPOT_ZOOM
    const zoom = fits
      ? Math.min(room, spotlight.wide ? Math.min(close, WIDE_SPOT_ZOOM) : close)
      : MIN_SPOT_ZOOM
    spotHeld.current = fitKey
    const centerY = fits
      ? item.position.y + h / 2
      : item.position.y + frame.clientHeight / zoom / 2 - margin / zoom
    void setCenter(item.position.x + w / 2, centerY, {
      zoom,
      // Hacia una caja que crece, despacio: es un acompañar, no un salto.
      duration: animate ? (spotlight.camera ? 700 : 450) : 0,
    })
  }, [spotlight, motionItems, setCenter, animate, fitKey, follow])

  // Un lienzo de trabajo (que se ajusta al ancho) pliega sus filas según el ancho que tiene.
  const narrowing = interactive && (fitMode ?? 'width') === 'width'
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !narrowing) return
    // El observador avisa nada más empezar a mirar: no hace falta medir a mano.
    const observer = new ResizeObserver(() => {
      setRun(runFor(frame.clientWidth))
      setArchRun(archRunFor(frame.clientWidth))
      const w = Math.floor(frame.clientWidth / 40) * 40
      const h = Math.floor(frame.clientHeight / 40) * 40
      setFrameSize((known) => (known?.w === w && known.h === h ? known : { w, h }))
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
      className={['canvas stage', framed ? 'rounded-lg border border-border-card' : '', className]
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
        nodes={[
          ...figureNodes,
          ...flowNodes,
          ...resultNodes,
          ...dockedNodes,
          ...sideFlow.nodes,
          ...noteFlow.nodes,
        ]}
        // (Las de la arquitectura son otro tipo de arista; el lienzo solo las dibuja, no las edita.)
        edges={[
          ...(labelledEdges as unknown as PryselFlowEdge[]),
          ...(resultEdges as unknown as PryselFlowEdge[]),
          ...(exitEdges as unknown as PryselFlowEdge[]),
          ...flowEdges,
          ...sideFlow.edges,
          ...noteFlow.edges,
        ]}
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
        // Solo los cables que lo dicen (`reconnectable`) se mueven: los de orden y control, no.
        edgesReconnectable={false}
        onReconnect={connectable ? onReconnect : undefined}
        onReconnectStart={
          connectable
            ? (_, edge, fixed) => {
                setQuick(null)
                // Se mueve la punta: se iluminan las casillas donde valdría, como al tender uno nuevo.
                const was = cableOf(edge)
                setConnecting(
                  fixed === 'source' && was
                    ? {
                        from: was.from,
                        ...(was.fromPort?.startsWith('param:') ? { port: was.fromPort } : {}),
                      }
                    : null,
                )
              }
            : undefined
        }
        onReconnectEnd={connectable ? onReconnectEnd : undefined}
        reconnectRadius={14}
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
                if (!node.id.startsWith(FUNCTION_CHIP) && !noteIds.has(node.id)) select(node.id)
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
                } else if (!noteIds.has(node.id)) onNodeDrag(node)
              }
            : undefined
        }
        onNodeDragStop={
          interactive
            ? (_, node) => {
                setDragging(false)
                if (isDockedChip(node.id)) chipDrag.drop(node.id)
                else if (noteIds.has(node.id)) {
                  // Lo que se aparta del sitio que le da el margen: eso es lo que se guarda (y sigue valiendo
                  // aunque el diagrama se reordene).
                  const at = notePlaced.current.get(node.id)
                  if (at) {
                    onNoteMove?.(node.id, {
                      x: Math.round(node.position.x - at.x),
                      y: Math.round(node.position.y - at.y),
                    })
                  }
                } else onNodeDrop(node.id)
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
        {interactive && <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} />}
        {interactive && controls && (
          <Panel position="bottom-right" className="canvas-controls">
            <IconButton
              icon="plus"
              label="Acercar"
              onClick={() => {
                void zoomIn({ duration: animate ? 180 : 0 })
              }}
            />
            <IconButton
              icon="minus"
              label="Alejar"
              onClick={() => {
                void zoomOut({ duration: animate ? 180 : 0 })
              }}
            />
            <span className="canvas-controls__sep" aria-hidden />
            <IconButton
              icon="frame"
              label="Encuadrar todo"
              onClick={() => {
                // Vuelve a encuadrar como al principio: el lienzo deja de estar «tomado» por el usuario.
                setTakenKey(null)
                spotHeld.current = null
                setRefits((n) => n + 1)
              }}
            />
          </Panel>
        )}
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
