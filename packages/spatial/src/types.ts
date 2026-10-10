import type { Role } from '@prysel/morphology'
import type { Figure } from './architecture.ts'

/**
 * Gramática espacial: la quinta gramática de Prysel.
 *
 * Regla central: **el espacio es un lenguaje semántico**. La posición, la topología,
 * la orientación, la profundidad y el movimiento no son decoración ni resultado de un
 * `autoLayout()` genérico — son la forma visual de la topología computacional.
 *
 * El recorrido es: AST → grafo semántico → clasificación espacial → estrategia → grafo visual.
 * Este paquete cubre los tres pasos centrales y no sabe nada de React.
 */

export interface Point {
  x: number
  y: number
}

export interface Size {
  w: number
  h: number
}

/**
 * Cómo se relacionan dos nodos. No es un estilo de línea: es la relación computacional,
 * y de ella se derivan el trazo, la punta y la curvatura.
 */
export type Relation =
  /** B usa el valor que produce A. La dependencia más simple. */
  | 'dependency'
  /** El dato entra en B y sale distinto: el flujo principal del programa. */
  | 'transform'
  /** Una de las salidas de una decisión. Lleva etiqueta (verdadero / falso / caso). */
  | 'branch'
  /** Varias fuentes que desembocan en un mismo destino. */
  | 'merge'
  /** El control vuelve atrás: cierra un bucle. Es la única que puede ir hacia la izquierda. */
  | 'feedback'
  /** Dependencia débil: un import, un tipo, un símbolo al que se alude sin que fluya un dato. */
  | 'reference'
  /**
   * B se ejecuta justo después de A. Es el **orden** del programa: cada sentencia a continuación de la
   * anterior, y lo que sigue a una decisión saliendo de sus dos caminos. No se dibuja por defecto (en
   * un bloque lineal ya lo dice la posición): es lo que la colocación sigue para ordenar el plano.
   */
  | 'sequence'

/**
 * El canal por el que viaja una conexión. Son dos lenguajes visuales distintos y no deben
 * confundirse: en un algoritmo denso, mezclarlos es lo que vuelve ilegible el lienzo.
 *
 * - **control**: el orden de ejecución — qué se ejecuta después, por qué camino, cuándo se repite.
 *   Continua y gruesa: es la columna vertebral del programa.
 * - **datos**: el paso de valores — qué variable alimenta a qué operación.
 *   Fina y punteada: es una dependencia, no un camino.
 */
export type Channel = 'control' | 'data'

/** El canal de cada relación cuando la conexión no dice otra cosa. */
export const CHANNEL_OF: Record<Relation, Channel> = {
  dependency: 'data',
  transform: 'data',
  merge: 'data',
  reference: 'data',
  branch: 'control',
  feedback: 'control',
  sequence: 'control',
}

export interface SemanticNode {
  id: string
  /** Rol morfológico. La clasificación espacial lo usa como pista, nunca como única señal. */
  role: Role
  /** Tamaño ya resuelto por la morfología: el layout necesita medidas reales. */
  size: Size
  /** Nivel de abstracción al que pertenece. 0 = la superficie del programa. */
  depth?: number
  /** Nodos del nivel siguiente que este nodo encapsula (profundidad semántica). */
  contains?: string[]
  /** Operaciones que esconde. El tamaño de un nodo mide la complejidad que encapsula. */
  ops?: number
  /** Sitio extra que pide la cabecera de un ámbito (su documentación), sobre `SCOPE_FRAME.top`. */
  headroom?: number
  /** Sitio extra al pie de un ámbito, bajo su contenido (el carril por el que vuelve un bucle). */
  footroom?: number
  /**
   * Sitio extra a la izquierda, dentro del ámbito, para sus puertos: los parámetros de una función
   * salen de su borde, y sus etiquetas y sus cables necesitan aire antes de llegar al primer nodo.
   */
  gutter?: number
  /** Ancho que pide lo que hay en la cabecera (la cajita de chips): el territorio no puede ser más estrecho. */
  headerWidth?: number
  /** Es un territorio aunque no sea una abstracción: un bucle con cuerpo envuelve lo que repite. */
  territory?: boolean
  /** Tamaño mínimo de un ámbito que el usuario ha ensanchado: nunca queda por debajo de su contenido. */
  minSize?: Size
  /**
   * La sentencia que lo envuelve (una decisión, un bucle, una función). Leído como diagrama de flujo, dice
   * qué pasos son de cada camino de una decisión y dónde se vuelven a juntar.
   */
  owner?: string
  /**
   * Dónde cae su espina, medido desde su borde izquierdo (sin él, en el centro). Un territorio leído como
   * diagrama de flujo la tiene donde la tenga su contenido: por ahí entra y sale la secuencia.
   */
  spine?: number
}

export interface SemanticEdge {
  from: string
  to: string
  relation: Relation
  /** Puerto de salida concreto (una condición tiene dos). */
  fromPort?: string
  /**
   * Puerto de ENTRADA concreto: qué campo del nodo destino alimenta.
   * Sin esto, dos conexiones que llegan al mismo nodo son ambiguas.
   */
  toPort?: string
  /** Etiqueta de la relación: "verdadero", "falso", "cada fila". */
  label?: string
  /**
   * Si la conexión se dibuja saltándose un nodo que no se enseña (un `return` que solo devuelve una
   * variable), el nodo del que en realidad sale o al que llega: es donde se escribe al cambiarla.
   */
  via?: string
  /**
   * Canal explícito. Casi siempre se deduce de la relación; solo hace falta cuando una misma
   * relación se usa en los dos sentidos (la entrada al cuerpo de un bucle es control, pero
   * se traza como una transformación).
   */
  channel?: Channel
}

export function channelOf(edge: Pick<SemanticEdge, 'relation' | 'channel'>): Channel {
  return edge.channel ?? CHANNEL_OF[edge.relation]
}

export interface SemanticGraph {
  nodes: SemanticNode[]
  edges: SemanticEdge[]
}

/**
 * La forma que tiene un conjunto de nodos. Se detecta a partir del grafo,
 * nunca se declara a mano en la interfaz.
 */
export type Topology =
  'pipeline' | 'branch' | 'loop' | 'aggregation' | 'fan-out' | 'comparison' | 'nesting'

/** Cómo se dibuja cada topología en el plano. */
export type Strategy =
  'linear' | 'tree' | 'orbital' | 'convergent' | 'radial' | 'parallel' | 'nested'

/**
 * La tabla que traduce lógica en forma. Es el corazón de la gramática espacial:
 * cambiar aquí cambia cómo se ve todo programa que tenga esa estructura.
 */
export const STRATEGY_FOR: Record<Topology, Strategy> = {
  pipeline: 'linear',
  branch: 'tree',
  loop: 'orbital',
  aggregation: 'convergent',
  'fan-out': 'radial',
  comparison: 'parallel',
  nesting: 'nested',
}

/** Por qué cada topología se dibuja así — el texto que justifica la regla. */
export const TOPOLOGY_RULES: Record<Topology, { name: string; why: string }> = {
  pipeline: {
    name: 'Pipeline',
    why: 'Una cadena de pasos se lee como una frase: de izquierda a derecha, en una sola línea, sin desvíos que inventen jerarquía donde no la hay.',
  },
  branch: {
    name: 'Decisión',
    why: 'Una bifurcación se dibuja como un árbol con las ramas físicamente separadas — arriba lo verdadero, abajo lo falso — porque el programa realmente se parte en dos caminos.',
  },
  loop: {
    name: 'Bucle',
    why: 'La repetición se dibuja en órbita alrededor de su cabecera y se cierra con la conexión de retorno: el espacio mismo vuelve al punto de partida.',
  },
  aggregation: {
    name: 'Agregación',
    why: 'Varias fuentes que desembocan en un destino convergen hacia él: las líneas se juntan porque los datos se juntan.',
  },
  'fan-out': {
    name: 'Fan-out',
    why: 'Un valor que alimenta a muchos se coloca en el centro de un abanico: la distancia a cada consumidor es la misma porque ninguno es más importante.',
  },
  comparison: {
    name: 'Comparación',
    why: 'Dos caminos que hacen lo mismo de forma distinta se dibujan paralelos y alineados, para que la diferencia entre ellos sea lo único que salte a la vista.',
  },
  nesting: {
    name: 'Anidamiento',
    why: 'Lo que está contenido se dibuja dentro, no al lado: la pertenencia es una relación espacial antes que una línea.',
  },
}

/**
 * Eje de lectura de un programa. La gramática no asume izquierda-a-derecha: una secuencia
 * de pasos puede leerse mejor en vertical, como una lista, y la topología decide cuál le toca.
 */
export type Axis = 'horizontal' | 'vertical'

/** El eje que le sienta mejor a cada topología. */
export const AXIS_FOR: Record<Topology, Axis> = {
  pipeline: 'horizontal',
  branch: 'horizontal',
  loop: 'horizontal',
  aggregation: 'horizontal',
  'fan-out': 'horizontal',
  comparison: 'horizontal',
  // Lo anidado se lee como una lista de pasos dentro de su contenedor.
  nesting: 'vertical',
}

/** Un trozo del grafo que comparte una misma forma espacial. */
export interface Region {
  id: string
  topology: Topology
  strategy: Strategy
  /** Nodos que forman la región, en orden de lectura. */
  nodes: string[]
  /** El nodo que manda: la cabecera del bucle, la condición, el punto de convergencia. */
  anchor?: string
  /** Qué se detectó en el grafo para clasificarlo así. */
  evidence: string
}

export interface Placement extends Point {
  id: string
  size: Size
  /** La región que decidió esta posición. */
  region: string
  /** Fila del plegado: una secuencia larga salta de línea como un texto. */
  row: number
}

/**
 * El marco de un ámbito. Un `def` no es un nodo más: es un territorio que envuelve su cuerpo,
 * igual que la indentación agrupa el cuerpo de una función en el texto. La cabecera lleva la
 * insignia y el nombre; el resto es el margen que separa el contenido del borde.
 */
export const SCOPE_FRAME = { top: 66, side: 24, bottom: 24 } as const

/** Lo que se reserva a la izquierda de una función con parámetros (ver `GraphNode.gutter`). */
export const PARAM_GUTTER = 64

export interface LayoutResult {
  placements: Placement[]
  regions: Region[]
  bounds: Size
  /** Capa (profundidad topológica) de cada nodo: su posición en el orden de ejecución. */
  layers: Record<string, number>
  /** Eje de lectura con el que se colocó. */
  axis: Axis
  /** Cuántas filas ocupó el programa tras plegarse. */
  rows: number
  /** Ámbitos que envuelven a otros nodos: id del contenedor → nodos de su interior. */
  scopes: Record<string, string[]>
  /**
   * Leído como diagrama de flujo: dónde cae la espina (la x del eje por el que bajan los pasos).
   */
  spine?: number
  /** La espina de cada ámbito, medida desde su borde izquierdo: por ahí entra y sale su secuencia. */
  spines?: Record<string, number>
  /** Colocado como arquitectura: los dibujos de fondo que dicen su forma (un anillo, unas bandas). */
  figures?: Figure[]
}
