/**
 * Gramática visual de Prysel (v2).
 *
 * La tarjeta es la forma base: es lo que permite editar un nodo gráficamente.
 * La identidad del tipo se lee en la **insignia** (icono + color + nombre) y en el
 * **recorte de los bordes** de la tarjeta; el estado, en el **chip**. Nada es decorativo.
 */

export type Density = 'compact' | 'normal' | 'expanded'

/** Los seis estados del DS. El estado se lee en el chip, nunca en el relleno de la tarjeta. */
export type NodeState = 'dormant' | 'running' | 'success' | 'warning' | 'error' | 'selected'

/**
 * Silueta. Todas parten de una tarjeta; lo que cambia es el tratamiento de sus bordes,
 * y ese tratamiento dice qué papel juega el nodo en el flujo.
 */
export type ShapeId =
  | 'card'
  | 'card-chevron'
  | 'card-stack'
  | 'card-window'
  | 'card-grid'
  | 'card-tab'
  | 'card-notch'
  | 'card-cut'
  | 'card-fork'
  | 'card-loop'
  | 'card-flag'
  | 'card-endcap'
  | 'card-toggle'
  | 'card-double'
  | 'pill'
  | 'pill-chevron'
  | 'pill-cut'
  | 'frame'
  | 'frame-fork'
  | 'frame-guard'

/** Trazo. solid = entidad · dashed = contenedor · dotted = externo o sin resolver. */
export type StrokeStyle = 'solid' | 'dashed' | 'dotted'

/**
 * Relleno. solid = evaluado y conocido · glass = encapsula complejidad (desenfoque de fondo) ·
 * ghost = diferido o ajeno · none = territorio · hatch = pendiente de generarse (modificador).
 */
export type FillMode = 'solid' | 'glass' | 'ghost' | 'none' | 'hatch'

/** Familia de color de la insignia. `neutral` = sin tono propio. */
export type BadgeFamily =
  'value' | 'data' | 'transform' | 'control' | 'effect' | 'output' | 'neutral'

export type Role =
  | 'value'
  | 'data'
  | 'transform'
  | 'control'
  | 'effect'
  | 'output'
  | 'external'
  | 'abstraction'
  | 'opaque'
  | 'container'

/** Elevación: la sombra es atención. `raised` solo para lo que el usuario mira. */
export type Elevation = 'flat' | 'raised'

/** Qué mide el tamaño de un nodo: su complejidad, no su importancia. */
export type ScaleBy = 'none' | 'ops' | 'cardinality'

/** Icono de identidad del tipo, dibujado dentro de la insignia. */
export type IconId =
  | 'quote'
  | 'hash'
  | 'toggle'
  | 'circle-slash'
  | 'list'
  | 'braces'
  | 'table'
  | 'function'
  | 'sigma'
  | 'repeat'
  | 'lambda'
  | 'branch'
  | 'loop'
  | 'alert'
  | 'return'
  | 'globe'
  | 'chart'
  | 'package'
  | 'folder'
  | 'sparkles'
  | 'help'
  | 'shield'
  | 'check'
  | 'clock'
  | 'x'
  | 'dot'
  | 'diamond'
  | 'copy'
  | 'trash'
  | 'pencil'
  | 'chevron'
  | 'plus'
  | 'calendar'
  | 'exit'
  | 'skip'

/**
 * El editor gráfico que el nodo muestra en su cuerpo. Es lo que hace que un nodo sea
 * manipulable sin escribir código: al cambiarlo, cambia el Python que hay debajo.
 */
export type ControlId =
  | 'text'
  | 'number'
  | 'boolean'
  | 'constant'
  | 'list'
  | 'dict'
  | 'table'
  | 'args'
  | 'expression'
  | 'condition'
  | 'loop'
  | 'signal'
  | 'io'
  | 'stats'
  | 'module'
  | 'signature'
  | 'query'
  | 'code'
  | 'none'

export interface NodeKindSpec {
  id: string
  /** Nombre corto para humanos; también el texto de la insignia. */
  name: string
  /** Construcción de Python que representa. */
  python: string
  role: Role
  badge: BadgeFamily
  icon: IconId
  shape: ShapeId
  stroke: StrokeStyle
  fill: FillMode
  elevation: Elevation
  /** El editor gráfico del cuerpo. `none` = no hay nada que editar (contenedores). */
  control: ControlId
  /** Multiplicadores sobre el tamaño base de la densidad. */
  footprint: { w: number; h: number }
  scaleBy: ScaleBy
  /** Puertos que existen: un literal no tiene entrada; un `return` no tiene salida. */
  ports: { in: boolean; out: boolean }
  /** Por qué se ve así — la frase que justifica cada canal. */
  why: string
}

export interface Point {
  x: number
  y: number
}

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface Layer {
  d: string
  /** back = silueta completa detrás (pilas) · detail = línea interior (bandas, arcos, carriles). */
  kind: 'back' | 'detail'
  dx?: number
  dy?: number
}

export interface ShapeGeometry {
  /** Silueta principal (relleno, recorte y trazo). Origen en (0,0), tamaño w×h. */
  d: string
  layers: Layer[]
  handles: { in: Point; out: Point; alt?: Point }
  /** Área segura para contenido. */
  inset: Insets
  /** Alto de la banda de cabecera (barra de título de una ventana, pestaña de una función). */
  headerBand?: number
  /** Cuánto se sale la geometría de w×h (capas traseras de una pila). */
  overflow: Insets
}

export interface Metrics {
  /** Operaciones que encapsula (para nodos que escalan por complejidad). */
  ops?: number
  /** Elementos / filas (para colecciones). */
  cardinality?: number
}
