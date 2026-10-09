import { TEMPLATES, TEMPLATE_IDS, type NodeAction, type TemplateId } from '@prysel/morphology'
import type { Program, ProgramNode } from '@prysel/python'
import { isIdentifier } from '@prysel/python/edits'
import { MAX_CHOICES, type Decider, type JevAnswer, type JevQuestion } from './client.ts'

/**
 * El motor JEV: de una orden («añade un bucle dentro de entrenar») a una **directiva** que el lienzo ejecuta.
 *
 * Toda la interpretación la hace Jev, en una sola petición: si es una orden, qué pide, qué pieza, dónde y
 * sobre qué. Aquí solo se le pregunta bien (con conjuntos cerrados) y se resuelve lo que contesta con
 * umbrales fijos: si no está claro, **se pregunta, no se adivina**; lo que destruye pide más certeza.
 *
 * Es puro: recibe quién decide (`Decider`), así que se prueba entero con un decisor de mentira. Y no toca
 * el lienzo: la directiva lleva una acción del vocabulario que ya existe (`NodeAction`), que se escribe en el
 * Python. El diagrama se rehace desde el código, como siempre (ver `docs/voz.md`).
 */

export const INTENTS = [
  'agregar',
  'componer',
  'modificar',
  'narrar',
  'ensenar',
  'etapa',
  'eliminar',
  'mover',
  'envolver',
  'duplicar',
  'juntar',
  'extraer',
  'renombrar',
  'enfocar',
  'explicar',
  'plegar',
  'ejecutar',
  'paso_a_paso',
  'deshacer',
  'rehacer',
  'otra',
] as const
export type Intent = (typeof INTENTS)[number]

const INTENT_MEANING: Record<Intent, string> = {
  agregar:
    'Añadir UNA pieza sencilla de código, tal cual: una variable, un bucle, una decisión, imprimir algo, una función vacía…',
  componer:
    'Escribir algo que necesita varias piezas o lógica propia: un algoritmo, un programa entero, una función completa que calcula algo. También cuando solo se nombra o se describe algo que programar, sin verbo («una red neuronal artificial», «un juego de adivinar el número»).',
  narrar:
    'Explicar el programa entero con una lección narrada o animada, que lo recorre paso a paso.',
  etapa:
    'Empezar una etapa o sección con nombre en un punto del programa (un rótulo que agrupa pasos).',
  eliminar: 'Eliminar, borrar o quitar un elemento que ya existe.',
  mover:
    'Cambiar de sitio algo que YA existe, llevándolo a otra cosa que TAMBIÉN existe ya en el programa: meterlo dentro de ella («pon esta función dentro de la clase Animal», «mete esto en el bucle») o ponerlo antes o después («mueve esto después de aquello»).',
  envolver:
    'Meter algo que YA existe dentro de una estructura NUEVA, que se crea ahora para contenerlo: un bucle que lo repita, una decisión que lo condicione, un intento que recoja su error, o una clase nueva de la que pase a ser un método («mete esto en un bucle», «envuélvelo en un si», «que no falle si da error», «mete la función sumar en una clase Calculadora»).',
  duplicar:
    'Hacer una copia de algo que YA existe, justo debajo («duplica esto», «copia esa línea»).',
  juntar:
    'Unir dos cosas que YA existen en una sola («junta estas dos funciones», «une esto con aquello», «fusiónalas»).',
  extraer:
    'Sacar algo que YA existe a una función propia, y dejar en su sitio la llamada («extrae esto a una función», «convierte este trozo en una función»).',
  modificar:
    'Cambiar código que YA está escrito: que haga otra cosa, corregirlo, refactorizarlo, simplificarlo, cambiar un valor o una operación («ahora que reste en lugar de sumar», «refactoriza esto»).',
  renombrar: 'Solo cambiar el nombre de una variable, una función o una etapa que ya existe.',
  enfocar:
    'Mover la vista, sin cambiar nada: ver, ir a, entrar en o buscar algo que ya existe («ver la clase Animal», «entra en sumar»), o volver al programa principal («ver el programa», «sal de aquí»).',
  ensenar:
    'Querer entender un tema, un concepto o cómo funciona algo que NO es un elemento de este programa («explícame cómo funciona la reproducción humana», «qué es una red neuronal», «cómo se calcula el interés compuesto»).',
  explicar:
    'Pedir que se explique un elemento que SÍ está en este programa: una función, un bucle, una línea, lo seleccionado.',
  plegar: 'Plegar, abrir, desplegar o cerrar un bloque, una función o una etapa del diagrama.',
  ejecutar: 'Ejecutar o correr el programa, o una parte.',
  paso_a_paso: 'Reproducir el programa paso a paso, línea a línea.',
  deshacer: 'Deshacer el último cambio.',
  rehacer: 'Rehacer el cambio que se acaba de deshacer.',
  otra: 'Otra cosa que no es ninguna de las anteriores.',
}

/** Cómo se nombra cada intención al preguntar al usuario cuál quería. */
const INTENT_LABEL: Record<Intent, string> = {
  agregar: 'Añadir algo',
  componer: 'Escribir el código',
  narrar: 'Una lección narrada',
  ensenar: 'Explicar el tema',
  etapa: 'Empezar una etapa',
  eliminar: 'Eliminar',
  mover: 'Moverlo',
  envolver: 'Envolverlo',
  duplicar: 'Duplicarlo',
  juntar: 'Juntarlos',
  extraer: 'Extraerlo a una función',
  modificar: 'Cambiar lo que hay',
  renombrar: 'Renombrar',
  enfocar: 'Ir a verlo',
  explicar: 'Explicarlo',
  plegar: 'Plegar o abrir',
  ejecutar: 'Ejecutar',
  paso_a_paso: 'Paso a paso',
  deshacer: 'Deshacer',
  rehacer: 'Rehacer',
  otra: 'Otra cosa',
}

export const PLACES = ['final', 'principio', 'despues', 'dentro', 'camino_si', 'camino_no'] as const
export type PlaceId = (typeof PLACES)[number]

const PLACE_MEANING: Record<PlaceId, string> = {
  final: 'Al final de lo que se está viendo, o la orden no dice dónde.',
  principio: 'Al principio o al inicio de lo que se está viendo.',
  despues: 'Después, detrás o debajo de un elemento concreto (o del seleccionado).',
  dentro: 'Dentro de un bucle, una función u otro bloque concreto (o del seleccionado).',
  camino_si: 'En el camino del «sí» de una decisión: lo que se hace cuando la condición se cumple.',
  camino_no: 'En el camino del «no» de una decisión: su else, lo que se hace cuando no se cumple.',
}

/**
 * Los umbrales con los que se resuelve. Son fijos (no se ajustan solos): la misma respuesta de Jev da
 * siempre la misma directiva.
 */
export const THRESHOLDS = {
  /** Por debajo, lo dicho no era una orden: no se hace nada. */
  order: 0.5,
  /** Por debajo, no está claro qué se pide: se pregunta. */
  intent: 0.45,
  piece: 0.4,
  /** Por debajo, con un programa ya escrito, no se pone una plantilla: lo resuelve la IA. */
  pieceSure: 0.75,
  /** Por debajo, el sitio es el de siempre: dentro o detrás de lo seleccionado, o al final. */
  place: 0.4,
  target: 0.45,
  /** Lo que destruye (eliminar) pide más certeza, en la intención y en el objetivo. */
  destructive: 0.7,
  /** Por encima, la orden son varias órdenes seguidas: se parte y se decide cada una. */
  several: 0.6,
  /** Por encima, la orden retoca lo que se acaba de hacer: se cambia eso, no se empieza otra cosa. */
  followUp: 0.7,
  /** Por debajo, mover o envolver no está claro: si además la orden es un retoque, se trata como tal. */
  structural: 0.8,
} as const

/** Lo que el usuario ya aclaró al contestar una pregunta: no se le vuelve a preguntar a Jev. */
export interface Forced {
  intent?: Intent
  piece?: TemplateId
  /** El id del nodo o de la etapa sobre la que actuar. */
  target?: string
}

export interface EngineInput {
  text: string
  program: Program
  /** Lo que está seleccionado en el lienzo (el id de un nodo o de una etapa). */
  selected: string | null
  /** La función que se está viendo, si no es el programa entero. */
  focus: string | null
  forced?: Forced
  /**
   * Si hay con qué escribir el contenido después (una IA generativa): el id con el que la pieza nueva nace
   * marcada como «generándose». Sin él, la pieza se queda en su plantilla, y no hay órdenes complejas.
   */
  genId?: string
  /** Es un trozo de una orden que ya se partió: no se vuelve a partir. */
  single?: boolean
  /** Las líneas de lo último que una orden construyó o cambió: «eso», «lo que acabas de hacer». */
  last?: { from: number; to: number }
  /**
   * Se escribió en la caja de órdenes (no se oyó de pasada): es una orden, sin más. Lo que no encaja en
   * nada se toma como algo que construir, no como ruido.
   */
  typed?: boolean
  /**
   * La conversación hasta ahora: las últimas órdenes y lo que se hizo con cada una, de la más antigua a la
   * más reciente. Sin ella, un «pero usando la clase» no se sabe a qué se refiere.
   */
  history?: readonly { order: string; did: string }[]
}

/** Dónde se escribe algo nuevo (lo mismo que admite la acción de añadir). */
export type Spot = Pick<Extract<NodeAction, { type: 'add' }>, 'after' | 'into' | 'at' | 'branch'>

/** Lo que la directiva hace: una edición del código, o algo del propio lienzo. */
export type Effect =
  | { type: 'action'; action: NodeAction }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'run'; ids: string[] | 'all' }
  | { type: 'trace' }
  | { type: 'focus' }
  | { type: 'fold'; id: string }
  /**
   * Una orden compleja: el JEV decide que hay que escribir código y dónde; lo redacta la IA generativa y,
   * antes de escribirlo, el JEV lo juzga (ver `compose.ts`). Llega después, como un contenido generado.
   */
  | {
      type: 'compose'
      gen: string
      place: Spot
      where: string
      /** Es grande: primero el esquema de etapas, y luego cada una. Si no, directo a los pasos. */
      outline: boolean
      /**
       * No se pidió un programa, sino **entender un tema**: se construye un modelo pequeño que lo explique,
       * y lo que se dice en cada paso cuenta el tema, no solo el código.
       */
      teach?: boolean
    }
  /**
   * Cambiar lo que ya está escrito: el JEV decide que es un cambio y sobre qué; la IA generativa dicta
   * los cambios uno a uno (ver `modify.ts`).
   */
  | { type: 'modify'; gen: string; lines?: { from: number; to: number }; scope?: string }
  /** Generar la lección narrada del archivo y reproducirla. */
  | { type: 'lesson' }

export type Directive =
  | {
      kind: 'do'
      intent: Intent
      effect: Effect
      /** A qué va la cámara (lo que se crea se enfoca solo, al aparecer). */
      focus?: string
      /** Lo que se dice en voz alta, y se enseña. */
      say: string
      /** La pieza nace «generándose»: su contenido llega después. */
      pending?: { id: string; template: TemplateId }
      /** Hay que explicar este elemento (lo redacta la IA generativa, después). */
      explain?: string
      /**
       * La orden es una pregunta sobre el programa: la contesta la IA generativa, después, mirándolo entero,
       * y se señala el sitio que lo decide. No cambia el código.
       */
      answer?: boolean
      /** La vista vuelve al programa principal: se sale de la función o la clase que se estuviera viendo. */
      home?: boolean
      /**
       * Cómo se enseña lo que se va a hacer, antes de que cambie el código: lo que se envuelve se enmarca, lo
       * que se copia se desdobla, lo que se junta viaja hasta lo otro, lo que se extrae se levanta.
       */
      gesture?: { kind: 'wrap' | 'copy' | 'merge' | 'extract'; id: string; to?: string }
    }
  | {
      kind: 'ask'
      question: string
      /** Es una confirmación de sí o no, ya concreta: no hay que pedirle a la IA que la mejore. */
      plain?: boolean
      /** Cada salida aclara la orden (`force`) o es otra orden, ya completa (`order`). */
      options: { label: string; force?: Forced; order?: string }[]
    }
  /** Son varias órdenes en una: la IA generativa la parte, y el JEV decide cada trozo por separado. */
  | { kind: 'several'; say: string }
  /** No era una orden. */
  | { kind: 'ignored'; say: string }
  /** Era una orden, pero no se puede cumplir (o falta un dato que hay que decir). */
  | { kind: 'unknown'; say: string }
  /** No hubo decisión: sin clave, sin red, o el archivo cambió. */
  | { kind: 'failed'; say: string; needsKey?: boolean }

/** Lo que contestó Jev a cada pregunta: se enseña junto a la orden, para que se vea por qué se hizo. */
export interface Evidence {
  question: string
  answer: string
  confidence: number
}

export interface Decision {
  directive: Directive
  evidence: Evidence[]
  /** Quién decidió. */
  engine: string
  /** Lo que tardó en decidir. */
  jevMs: number
}

// ───────────────────────── el catálogo: sobre qué se puede actuar ─────────────────────────

export interface Target {
  /** El nombre corto con el que Jev lo elige (`p12`, `e3`). */
  ref: string
  /** El id del nodo o de la etapa. */
  id: string
  what: string
  /** Su primera línea (o el título de la etapa). */
  head: string
  line: number
  /** Su última línea. */
  lineEnd: number
  node?: ProgramNode
  /** En una etapa: su última sentencia (lo que se añade «dentro» o «después» va tras ella). */
  last?: string
  description: string
}

/** Las opciones `ninguno` y `seleccionado` ocupan sitio en la pregunta. */
const MAX_TARGETS = MAX_CHOICES - 5

function whatOf(node: ProgramNode): string {
  const kind: string = node.kind
  if (kind === 'abstraction.collapsed') return 'función'
  if (kind === 'abstraction.class') return 'clase'
  if (kind === 'control.loop') return 'bucle'
  if (kind === 'control.condition') return 'decisión'
  if (kind === 'control.return') return 'devolución'
  if (kind === 'control.entrypoint') return 'programa principal'
  if (kind === 'external.import') return 'importación'
  if (node.provides !== undefined) return 'variable'
  return 'paso'
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const headOf = (node: ProgramNode) =>
  clip(((node.text ?? node.label).split(/\r?\n/)[0] ?? '').trim(), 70)

/** La función (o la clase) que contiene a un nodo, subiendo por sus dueños. */
function enclosing(byId: ReadonlyMap<string, ProgramNode>, node: ProgramNode): ProgramNode | null {
  let owner = node.range?.owner
  while (owner !== undefined) {
    const parent = byId.get(owner)
    if (!parent) return null
    if (parent.kind === 'abstraction.collapsed' || parent.kind === 'abstraction.class')
      return parent
    owner = parent.range?.owner
  }
  return null
}

function within(byId: ReadonlyMap<string, ProgramNode>, node: ProgramNode, id: string): boolean {
  let owner = node.range?.owner
  while (owner !== undefined) {
    if (owner === id) return true
    owner = byId.get(owner)?.range?.owner
  }
  return false
}

/**
 * Todo aquello sobre lo que una orden puede actuar: las sentencias del programa y sus etapas. Lo que se
 * está viendo va primero (si no cabe todo, es lo que se queda).
 */
export function targetsOf(program: Program, focus: string | null): Target[] {
  const byId = new Map(program.nodes.map((node) => [node.id, node]))
  const statements = program.nodes.filter((node) => node.range !== undefined)
  const seen = (node: ProgramNode) =>
    focus === null ? enclosing(byId, node) === null : node.id === focus || within(byId, node, focus)
  const ordered = [...statements.filter(seen), ...statements.filter((node) => !seen(node))].slice(
    0,
    MAX_TARGETS,
  )
  const targets: Target[] = ordered.map((node, index) => {
    const what = whatOf(node)
    const head = headOf(node)
    const home = enclosing(byId, node)
    return {
      ref: `p${index + 1}`,
      id: node.id,
      what,
      head,
      line: node.line,
      lineEnd: node.lineEnd ?? node.line,
      node,
      description: `${what} «${head}» · línea ${node.line}${home ? ` · en ${home.label}` : ''}`,
    }
  })
  const room = MAX_TARGETS - targets.length
  ;(program.sections ?? []).slice(0, Math.max(0, room)).forEach((section, index) => {
    const last = section.members[section.members.length - 1]
    targets.push({
      ref: `e${index + 1}`,
      id: section.id,
      what: 'etapa',
      head: clip(section.title, 70),
      line: section.line,
      lineEnd: section.lineEnd,
      ...(last === undefined ? {} : { last }),
      description: `etapa «${clip(section.title, 70)}» · líneas ${section.line}–${section.lineEnd}`,
    })
  })
  return targets
}

// ───────────────────────── las preguntas ─────────────────────────

const NONE = 'ninguno'
const SELECTED = 'seleccionado'
const NO_PIECE = 'ninguna'
const LAST = 'ultimo'

export interface Asked {
  state: Record<string, unknown>
  questions: Record<string, JevQuestion>
}

/** El estado y las preguntas de una orden: todas van en una sola petición. */
export function questionsFor(input: EngineInput, targets: readonly Target[]): Asked {
  const forced = input.forced ?? {}
  const chosen = targets.find((target) => target.id === input.selected)
  const viewing = targets.find((target) => target.id === input.focus)
  const history = input.history ?? []
  const state = {
    orden: input.text,
    viendo: viewing ? `la función «${viewing.head}»` : 'el programa entero',
    seleccionado: chosen ? chosen.description : 'nada',
    // Lo que se ha ido pidiendo antes, y lo que se hizo: la orden puede referirse a ello.
    ...(history.length > 0
      ? { antes: history.map((turn) => `«${turn.order}» → ${turn.did}`) }
      : {}),
  }
  const questions: Record<string, JevQuestion> = {}
  // ¿Es un retoque de lo que se acaba de hacer? Se pregunta siempre que haya un «antes».
  if (forced.intent === undefined && history.length > 0 && input.genId !== undefined) {
    questions.sigue = {
      type: 'noul',
      instructions:
        'El campo `antes` es lo que se ha pedido y hecho justo antes. La `orden` de ahora, ¿corrige, matiza o completa ESO MISMO que se acaba de hacer, en vez de pedir una cosa nueva e independiente?',
      criteria: {
        true: 'Retoca lo que se acaba de hacer: «pero usando la clase», «no, que reste», «mejor con un bucle», «que lo haga con el objeto que creaste». Sola no se entendería.',
        false:
          'Pide algo nuevo, que se entiende por sí solo: otra función, otra clase, ver algo, borrar algo.',
      },
    }
  }
  if (forced.intent === undefined) {
    // Lo que se escribe en la caja de órdenes va dirigido al editor: no hace falta preguntarlo.
    if (!input.typed) {
      questions.es_orden = {
        type: 'noul',
        instructions:
          'El campo `orden` es lo que alguien acaba de decir a un editor de diagramas de programas en Python. ¿Va dirigido al editor?',
        criteria: {
          true: 'Pide algo, nombra o describe algo que programar, o pregunta por el programa.',
          false: 'Es charla con otra persona, una frase a medias o ruido.',
        },
      }
    }
    questions.accion = {
      type: 'choice',
      instructions: '¿Qué pide la `orden` que haga el editor?',
      criteria: Object.fromEntries(INTENTS.map((intent) => [intent, INTENT_MEANING[intent]])),
    }
    if (input.genId !== undefined && !input.single) {
      questions.varias = {
        type: 'noul',
        instructions:
          '¿La `orden` contiene varias instrucciones distintas para el editor, una detrás de otra?',
        criteria: {
          true: 'Pide dos o más cosas separadas: «añade una variable y luego renómbrala», «borra esto y ejecuta».',
          false: 'Pide una sola cosa, aunque sea larga o describa un algoritmo con varios pasos.',
        },
      }
    }
    // «Muestra el tablero» se puede entender de dos maneras: llévame a verlo en el diagrama, o que el
    // programa lo muestre al ejecutarse. Con las claves de verdad el JEV lo leía siempre como lo primero, y
    // el «muéstralo» de «crea un tablero y muéstralo» se quedaba sin hacer. Cuando la orden usa uno de esos
    // verbos, se le pregunta aparte cuál de las dos es.
    if (
      input.genId !== undefined &&
      input.program.nodes.length > 0 &&
      SHOWS.test(plainText(input.text))
    ) {
      questions.ver = {
        type: 'choice',
        instructions:
          'La `orden` pide «mostrar», «enseñar» o «imprimir» algo. ¿Qué quiere quien la da: mirar él esa parte del diagrama, o que el programa lo muestre cuando se ejecute?',
        criteria: {
          diagrama:
            'Quiere ir a mirar una parte del diagrama: que la vista vaya allí, sin cambiar el programa. «Enséñame la clase animal», «muéstrame la función sumar», «ver el programa principal».',
          programa:
            'Quiere que el PROGRAMA lo muestre al ejecutarse: que lo imprima, o que llame a la función que lo muestra. Es un cambio en el código. «Muestra el tablero», «imprime el total», «muéstralo» justo después de pedir que se cree algo.',
        },
      }
    }
    if (input.genId !== undefined && input.program.nodes.length > 0) {
      // «¿Cómo sabe cuándo he ganado?» pregunta por ESTE programa. Con las claves de verdad se entendía como
      // un tema que enseñar, y se escribía un modelo nuevo (una copia del juego) al final del programa de
      // quien solo quería entender el suyo.
      if (ASKS.test(plainText(input.text))) {
        questions.sobre = {
          type: 'choice',
          instructions:
            'La `orden` pregunta algo o pide una explicación. ¿Pregunta por ESTE programa (el que ya está escrito: cómo hace algo, por qué, qué pasa si…), o quiere aprender un tema nuevo que no es este programa?',
          criteria: {
            programa:
              'Pregunta por lo que este programa ya hace: «¿cómo sabe cuándo he ganado?», «¿por qué empieza en cero?», «¿qué pasa si escribo una letra?», «¿dónde se calcula el total?».',
            peticion:
              'No pregunta nada: pide que se haga o se cambie algo, aunque lo diga con forma de pregunta o empiece por «dime»: «¿puedes añadir un contador?», «dime cuánto llevo gastado», «¿y si tuviera tres vidas?».',
            tema: 'Quiere que se le enseñe un tema general, que no está en este programa: «explícame la recursión», «qué es una red neuronal», «cómo funciona el interés compuesto».',
          },
        }
      }
      // «Que pregunte si quiero jugar otra vez» no se cumple pegando una pregunta al final: hay que hacer
      // que el juego se repita. Si lo que se pide cambia cómo funciona lo que ya hay, no es añadir una pieza.
      questions.encaje = {
        type: 'choice',
        instructions:
          'El programa ya tiene código. Para cumplir la `orden`, ¿basta con añadir una pieza nueva y suelta, o hay que cambiar o envolver lo que ya está escrito?',
        criteria: {
          pieza:
            'Basta con añadir algo nuevo que no toca lo que hay: otra variable, otra función, imprimir un dato al final, una lista nueva.',
          cambio:
            'Hay que cambiar cómo funciona lo que ya está: que se repita, que tenga un límite, que pregunte y actúe según la respuesta, que haga otra cosa, que lo de antes pase solo en ciertos casos.',
        },
      }
    }
    // Se está viendo una función o una clase por dentro: lo que se pide, ¿es parte de ella o es algo aparte?
    if (input.genId !== undefined && input.focus !== null) {
      questions.ambito = {
        type: 'choice',
        instructions:
          'Quien da la `orden` está mirando por dentro una función o una clase del programa. Lo nuevo que pide, ¿es parte de eso que está mirando, o es algo aparte?',
        criteria: {
          dentro:
            'Es parte de lo que está mirando: un paso más de esa función, un método de esa clase, algo que dice «aquí» o «dentro».',
          programa:
            'Es algo propio, a la altura del programa: otra función, otra clase, otro programa. No va dentro de lo que está mirando.',
        },
      }
    }
    if (input.genId !== undefined) {
      questions.alcance = {
        type: 'choice',
        instructions: 'Si la `orden` pide escribir código nuevo, ¿cuánto es?',
        criteria: {
          directo:
            'Una pieza: una función, una clase, un bucle, unas sentencias, o algo que se añade a lo que ya hay (aunque use o contenga lo que ya existe). Se escribe directamente.',
          esquema:
            'Un programa o un algoritmo entero, con varias fases distintas. Conviene pensar primero sus etapas y luego detallar cada una.',
        },
      }
    }
  }
  if (forced.intent === undefined || forced.intent === 'agregar' || forced.intent === 'componer') {
    if (forced.piece === undefined) {
      questions.pieza = {
        type: 'choice',
        instructions: 'Si la `orden` pide añadir una pieza de código, ¿cuál es?',
        criteria: {
          ...Object.fromEntries(
            TEMPLATE_IDS.map((id) => [id, `${TEMPLATES[id].label}: ${TEMPLATES[id].hint}.`]),
          ),
          [NO_PIECE]: 'No pide añadir nada, o no dice qué.',
        },
      }
    }
    questions.donde = {
      type: 'choice',
      instructions: 'Si la `orden` pide añadir algo, ¿dónde lo quiere?',
      criteria: Object.fromEntries(PLACES.map((place) => [place, PLACE_MEANING[place]])),
    }
  }
  if (forced.target === undefined && targets.length > 0) {
    questions.objetivo = {
      type: 'choice',
      instructions:
        '¿A qué elemento del diagrama se refiere la `orden` (el que nombra, o junto al que quiere algo)?',
      criteria: {
        ...Object.fromEntries(targets.map((target) => [target.ref, target.description])),
        ...(chosen
          ? { [SELECTED]: 'A lo que está seleccionado: «esto», «este», «aquí», «el seleccionado».' }
          : {}),
        ...(input.last
          ? {
              [LAST]:
                'A lo último que se construyó o cambió: «eso», «lo de antes», «lo que acabas de hacer».',
            }
          : {}),
        [NONE]: 'No nombra ningún elemento concreto.',
      },
    }
    if (forced.intent === undefined || forced.intent === 'envolver') {
      questions.envolver_en = {
        type: 'choice',
        instructions: 'Si la `orden` pide meter algo dentro de una estructura nueva, ¿en cuál?',
        criteria: {
          bucle: 'Un bucle: que se repita.',
          decision: 'Una decisión: que solo pase si se cumple una condición.',
          intento: 'Un intento (try/except): SOLO si la orden habla de errores o de que no falle.',
          clase: 'Una clase: que pase a ser parte de ella (un método suyo).',
        },
      }
    }
    // Mover y juntar tienen dos extremos, y hay que saber cuál es cuál: se preguntan aparte (no cuesta nada).
    if (forced.intent === undefined || forced.intent === 'mover' || forced.intent === 'juntar') {
      const elements = {
        ...Object.fromEntries(targets.map((target) => [target.ref, target.description])),
        ...(chosen
          ? { [SELECTED]: 'Lo que está seleccionado: «esto», «este», «aquí», «el seleccionado».' }
          : {}),
        [NONE]: 'No lo dice.',
      }
      questions.mover_que = {
        type: 'choice',
        instructions:
          'Si la `orden` pide cambiar algo de sitio o juntarlo con otra cosa, ¿QUÉ elemento es el que se mueve (el que viaja)?',
        criteria: elements,
      }
      questions.mover_donde = {
        type: 'choice',
        instructions:
          'Si la `orden` pide cambiar algo de sitio o juntarlo con otra cosa, ¿cuál es el DESTINO: el elemento dentro del cual, junto al cual o con el cual va a quedar?',
        criteria: elements,
      }
      questions.mover_como = {
        type: 'choice',
        instructions: 'Si la `orden` pide cambiar algo de sitio, ¿cómo queda respecto al destino?',
        criteria: {
          dentro:
            'Dentro de él: pasa a ser parte de su interior (de la clase, de la función, del bucle).',
          despues: 'Justo después de él, a su misma altura.',
          antes: 'Justo antes de él, a su misma altura.',
        },
      }
    }
  }
  return { state, questions }
}

// ───────────────────────── lo que Jev no hace: sacar un nombre de la orden ─────────────────────────

/** Palabras que cierran una orden sin ser un nombre. */
const FILLER = new Set(['favor', 'gracias', 'ya', 'ahora', 'esto', 'eso', 'aqui', 'aquí'])

/**
 * El nombre nuevo de «renombra total a suma»: lo que va tras «a», «como» o «por» al final de la orden, o
 * su última palabra. Jev elige entre opciones, no copia texto: esto se saca de la orden tal cual.
 */
export function nameIn(text: string): string | null {
  const clean = text.trim().replace(/[.!?»"'`]+$/u, '')
  const tail = /(?:^|\s)(?:a|como|por)\s+[«"'`]?([\p{L}_][\p{L}\p{N}_]*)$/iu.exec(clean)
  const last = /([\p{L}_][\p{L}\p{N}_]*)$/u.exec(clean)
  const name = tail?.[1] ?? last?.[1]
  if (!name || FILLER.has(name.toLowerCase()) || !isIdentifier(name)) return null
  return name
}

/** El nombre de la clase que nombra una orden («…en una clase calculadora» → `Calculadora`), o `null`. */
export function classIn(text: string): string | null {
  const found =
    /\bclase\s+(?:nueva\s+)?(?:llamada\s+|que\s+se\s+llame\s+|de\s+nombre\s+)?([\p{L}_][\p{L}\p{N}_]*)/iu.exec(
      text,
    )?.[1]
  if (!found || FILLER.has(found.toLowerCase()) || !isIdentifier(found)) return null
  return found.charAt(0).toUpperCase() + found.slice(1)
}

/**
 * Los elementos que la orden nombra **tal cual** (una función, una clase o una variable por su nombre), en
 * el orden en que los dice. Es el respaldo de cuando el JEV no se decide entre ellos: si la orden dice
 * «sumar y restar» y hay una función `sumar` y otra `restar`, son esas.
 */
export function namedBy(text: string, targets: readonly Target[]): Target[] {
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
  // Un nombre se dice como se oye: `insertar_tarjeta` es «insertar tarjeta». Vale si sus palabras salen
  // seguidas en la orden.
  const found = targets.flatMap((target) => {
    const name = /^(?:(?:async\s+)?def|class)\s+(\w+)|^(\w+)\s*=(?!=)/.exec(target.head)
    const tokens = (name?.[1] ?? name?.[2] ?? '')
      .toLowerCase()
      .split('_')
      .filter((token) => token !== '')
    if (!target.node || tokens.length === 0) return []
    for (let at = 0; at + tokens.length <= words.length; at++) {
      if (tokens.every((token, k) => words[at + k] === token)) {
        return [{ target, at, end: at + tokens.length }]
      }
    }
    return []
  })
  // Dos cosas pueden llamarse igual (`class gato` y `gato = gato()`). La orden suele decir cuál: «el objeto
  // gato», «la clase gato», «la función…». Entre las que comparten sitio en la frase, gana la que es eso.
  const KIND_WORDS: [RegExp, RegExp][] = [
    [/^(objeto|instancia|variable|dato|valor)$/, /^\w+\s*=(?!=)/],
    [/^(clase)$/, /^class\s/],
    [/^(funcion|metodo)$/, /^(?:async\s+)?def\s/],
  ]
  const saidKind = (at: number) =>
    KIND_WORDS.find(([word]) => word.test(words[at - 1] ?? '') || word.test(words[at - 2] ?? ''))
  const chosen = found.filter((entry) => {
    const rivals = found.filter((other) => other.at === entry.at && other.end === entry.end)
    const kind = saidKind(entry.at)
    if (rivals.length < 2 || !kind) return true
    // Si alguno de los que se llaman igual es de la clase que se dijo, solo vale ese.
    return (
      !rivals.some((rival) => kind[1].test(rival.target.head)) || kind[1].test(entry.target.head)
    )
  })
  // «insertar tarjeta y validar pin» nombra a `insertar_tarjeta_y_validar_pin`, no a las dos que lleva
  // dentro: lo que cae dentro de un nombre más largo no cuenta.
  return chosen
    .filter(
      (entry) =>
        !chosen.some(
          (other) =>
            other !== entry &&
            other.at <= entry.at &&
            other.end >= entry.end &&
            other.end - other.at > entry.end - entry.at,
        ),
    )
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.target)
}

/** El título de «empieza una etapa llamada Población inicial»: lo entrecomillado, o lo que va tras «llamada». */
export function titleIn(text: string): string | null {
  const quoted = /[«"“]([^«»"”]{1,80})[»"”]/u.exec(text)
  const named =
    /(?:llamad[ao]|titulad[ao]|que se llame|con el nombre|de nombre|con el t[ií]tulo)\s*:?\s+(.{1,80})$/iu.exec(
      text.trim(),
    )
  const after = /:\s+(.{1,80})$/u.exec(text.trim())
  const raw = (quoted?.[1] ?? named?.[1] ?? after?.[1])?.trim().replace(/[.!?]+$/u, '')
  if (!raw) return null
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

// ───────────────────────── la resolución ─────────────────────────

/** Pedir salir a la vista general: eso sí es solo mover la vista, aunque no nombre nada. */
const LEAVES =
  /(programa|principal|main|general|inicio|sal|salir|salgamos|fuera|atras|vuelve|volver|todo)/

/** Lo que suena a pregunta o a pedir una explicación. */
const ASKS =
  /[¿?]|\b(como|por que|para que|que hace|que pasa|que es|cuando|donde|explica\w*|cuenta(?:me)?|dime)\b/

/** Verbos que tanto piden ir a ver algo como que el programa lo enseñe. */
const SHOWS = /\b(muestra\w*|mostrar\w*|ensena\w*|imprim\w+|pinta(?:lo|la)?|dibuja(?:lo|la)?)\b/
const plainText = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const choice = (answer: JevAnswer | undefined) => (answer?.type === 'choice' ? answer : undefined)

/** Las opciones más probables de una respuesta, de más a menos. */
function ranked(answer: JevAnswer | undefined, skip: readonly string[] = []): string[] {
  const found = choice(answer)
  if (!found) return []
  return Object.entries(found.probabilities)
    .filter(([option, p]) => !skip.includes(option) && p > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([option]) => option)
}

const isCompound = (node: ProgramNode | undefined) => node?.range?.head !== undefined

const naming = (target: Target) => `${target.what} «${target.head}»`

type Placed = Pick<Extract<NodeAction, { type: 'add' }>, 'after' | 'into' | 'at' | 'branch'> & {
  phrase: string
}

/** Dónde va lo que se añade: lo que pidió la orden o, si no lo dijo, el sitio de siempre. */
function placeOf(place: PlaceId | null, anchor: Target | null, viewing: Target | null): Placed {
  const end: Placed = viewing
    ? { into: viewing.id, phrase: `al final de ${viewing.node?.label ?? viewing.head}` }
    : { phrase: 'al final del programa' }
  const behind = (target: Target): Placed => ({
    after: target.last ?? target.id,
    phrase: `después de ${naming(target)}`,
  })
  const inside = (target: Target): Placed => {
    if (target.node?.kind === 'control.condition') {
      return { into: target.id, branch: 'yes', phrase: `en el «sí» de ${naming(target)}` }
    }
    if (isCompound(target.node)) return { into: target.id, phrase: `dentro de ${naming(target)}` }
    return behind(target)
  }
  if (place === 'principio') {
    return viewing
      ? {
          into: viewing.id,
          at: 'start',
          phrase: `al principio de ${viewing.node?.label ?? viewing.head}`,
        }
      : { at: 'start', phrase: 'al principio del programa' }
  }
  if (place === 'final' || !anchor) return end
  if (place === 'despues') return behind(anchor)
  if (place === 'dentro') return inside(anchor)
  if (place === 'camino_si' || place === 'camino_no') {
    if (anchor.node?.kind !== 'control.condition') return inside(anchor)
    return place === 'camino_si'
      ? { into: anchor.id, branch: 'yes', phrase: `en el «sí» de ${naming(anchor)}` }
      : { into: anchor.id, branch: 'no', phrase: `en el «no» de ${naming(anchor)}` }
  }
  // La orden no dijo dónde: como el botón «Añadir», dentro de un bloque elegido o detrás de un paso.
  return inside(anchor)
}

export async function decideCommand(input: EngineInput, decider: Decider): Promise<Decision> {
  const targets = targetsOf(input.program, input.focus)
  const asked = questionsFor(input, targets)
  const { answers, ms } =
    Object.keys(asked.questions).length > 0 ? await decider.decide(asked) : { answers: {}, ms: 0 }
  const evidence: Evidence[] = Object.entries(answers).map(([question, answer]) =>
    answer.type === 'noul'
      ? { question, answer: answer.noul >= THRESHOLDS.order ? 'sí' : 'no', confidence: answer.noul }
      : { question, answer: answer.choice, confidence: answer.confidence },
  )
  const done = (directive: Directive): Decision => ({
    directive,
    evidence,
    engine: decider.id,
    jevMs: ms,
  })
  const forced = input.forced ?? {}

  const order = !input.typed && answers.es_orden?.type === 'noul' ? answers.es_orden.noul : 1
  if (order < THRESHOLDS.order) return done({ kind: 'ignored', say: 'No lo tomé como una orden.' })

  const several = answers.varias?.type === 'noul' ? answers.varias.noul : 0
  if (several >= THRESHOLDS.several) {
    return done({ kind: 'several', say: 'Son varias órdenes: las hago una a una.' })
  }

  const picked = choice(answers.accion)
  const heard = forced.intent ?? (INTENTS.find((id) => id === picked?.choice) as Intent | undefined)
  const sure = forced.intent !== undefined ? 1 : (picked?.confidence ?? 0)
  const likely = ranked(answers.accion, ['otra']).filter((id): id is Intent =>
    (INTENTS as readonly string[]).includes(id),
  )
  /**
   * Ser proactivo: con una IA que redacte, una orden poco clara no se devuelve con una pregunta genérica.
   * Se toma la lectura más probable —salvo que destruya algo: eso sí se pregunta— y, si no hay ninguna,
   * se entiende como algo que construir.
   */
  const doubtful = heard === undefined || heard === 'otra' || sure < THRESHOLDS.intent
  // Cuando no está claro qué se pide y ya hay un programa, lo más probable no se ejecuta a ciegas si es
  // escribir algo: añadir una plantilla «por si acaso» duplica lo que ya hay. Se le pasa a la IA con el
  // programa entero delante, que es quien puede ver qué hace falta tocar (y si hay que tocar algo).
  const WRITES: readonly Intent[] = [
    'agregar',
    'componer',
    'modificar',
    'etapa',
    'mover',
    'envolver',
    'duplicar',
    'juntar',
    'extraer',
    'renombrar',
  ]
  const hasCode = input.program.nodes.length > 0
  // La lectura más probable, si la hay. Cuando es escribir algo y ya hay un programa, no se ejecuta a
  // ciegas: decide la IA, con todo delante. Sin ninguna lectura, se entiende como algo nuevo que construir.
  const reading = likely[0] ?? (heard === 'otra' ? undefined : heard)
  const guess: Intent | undefined =
    !doubtful || input.genId === undefined || reading === 'eliminar'
      ? undefined
      : reading === undefined
        ? 'componer'
        : hasCode && WRITES.includes(reading)
          ? 'modificar'
          : sure >= 0.25
            ? reading
            : 'componer'
  // Leído como «ir a verlo», pero preguntado aparte dice que es el programa quien tiene que mostrarlo:
  // es un cambio en el código, y lo hace la IA con todo el programa delante.
  const shows = choice(answers.ver)
  const display =
    (guess ?? heard) === 'enfocar' && shows?.choice === 'programa' && shows.confidence >= 0.5
  // Una pregunta sobre lo que el programa ya hace no es una orden de escribir, aunque el JEV, dudando, la
  // lea como «añadir» (visto de verdad: «¿cómo sabe cuándo he ganado?» → añadir, al 24 %, y se cambió el
  // juego). Si dice claro que pregunta por este programa y no hay una intención firme de otra cosa, se
  // contesta.
  const about = choice(answers.sobre)
  const asking =
    hasCode &&
    input.genId !== undefined &&
    forced.intent === undefined &&
    forced.target === undefined &&
    about?.choice === 'programa' &&
    about.confidence >= 0.7 &&
    (doubtful || heard === 'ensenar' || heard === 'explicar')
  const intent = asking ? 'explicar' : display ? 'modificar' : (guess ?? heard)
  if (!asking && guess === undefined && (intent === undefined || sure < THRESHOLDS.intent)) {
    const options = likely.slice(0, 2)
    if (options.length === 0) {
      return done({ kind: 'unknown', say: 'No entendí qué quieres que haga.' })
    }
    return done({
      kind: 'ask',
      question: '¿Qué quieres hacer?',
      options: options.map((id) => ({ label: INTENT_LABEL[id], force: { ...forced, intent: id } })),
    })
  }

  if (intent === undefined)
    return done({ kind: 'unknown', say: 'No entendí qué quieres que haga.' })

  // Sobre qué: lo que el usuario ya aclaró, lo que Jev eligió con certeza o, si no, lo seleccionado.
  const byId = (id: string | null | undefined) => targets.find((target) => target.id === id) ?? null
  const chosen = byId(input.selected)
  const named = choice(answers.objetivo)
  const namedTarget =
    named && named.confidence >= THRESHOLDS.target
      ? named.choice === SELECTED
        ? chosen
        : (targets.find((target) => target.ref === named.choice) ?? null)
      : null
  // Si el JEV no lo tiene claro y la orden nombra un elemento tal cual, es ese (antes que lo que quedara
  // seleccionado de otra cosa).
  const literal = namedTarget === null ? (namedBy(input.text, targets)[0] ?? null) : null
  // Lo que quedó seleccionado solo es «de lo que se habla» si la orden lo señala («esto», «aquí») o si
  // lo que se pide es añadir algo (va junto a lo seleccionado, como con el botón). Para borrar, mover o
  // cambiar algo, una selección que se quedó de antes no dice nada: mandaría borrar lo que no se nombró.
  const pointed = /\b(esto|este|esta|estos|estas|aqui|eso|ese|esa|seleccionad[oa]s?)\b/.test(
    input.text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
  )
  const implied =
    pointed || intent === 'agregar' || intent === 'componer' || intent === 'etapa' ? chosen : null
  const target =
    forced.target !== undefined ? byId(forced.target) : (namedTarget ?? literal ?? implied)
  /** Con cuánta certeza se sabe el objetivo: lo que el usuario eligió a mano, o nombró, es seguro. */
  const targetSure =
    forced.target !== undefined || (namedTarget === null && (literal !== null || implied !== null))
      ? 1
      : (named?.confidence ?? 0)
  const viewing = byId(input.focus)
  // Mirando una función por dentro, «crea otra función» no la mete dentro de la que se mira: lo dice el
  // JEV. Solo cuenta si la orden no señala ningún elemento (ni lo nombra, ni hay nada seleccionado): un
  // «después» o un «final» sin nada a lo que referirse no apunta a ningún sitio de lo que se mira.
  // Lo que quedó seleccionado de antes tampoco cuenta como señalar: si la orden no lo nombra ni dice
  // «esto» o «aquí», no es junto a ello donde se pide. (Visto con el JEV de verdad: «crea un tablero», con
  // un bucle del programa aún seleccionado, acabó dentro de la función que se miraba.)
  const signalled =
    forced.target !== undefined ||
    namedTarget !== null ||
    literal !== null ||
    (pointed && chosen !== null)
  const ambit = choice(answers.ambito)
  const apartSpot = (place: PlaceId | null): Placed | null =>
    viewing !== null && !signalled && ambit?.choice === 'programa' && ambit.confidence >= 0.5
      ? place === 'principio'
        ? { at: 'start', phrase: 'al principio del programa' }
        : { phrase: 'al final del programa' }
      : null

  /** Una orden compleja: se decide dónde, y el código lo redacta la IA generativa (y lo juzga el JEV). */
  const compose = (teach = false): Decision => {
    if (input.genId === undefined) {
      return done({
        kind: 'unknown',
        say: teach
          ? 'Para explicarte eso construyendo un modelo hace falta una IA generativa: elige un modelo.'
          : 'Para escribir eso hace falta una IA generativa: configura un proveedor (DeepSeek, Anthropic o el de VS Code).',
      })
    }
    const where = choice(answers.donde)
    const size = choice(answers.alcance)
    const place =
      where && where.confidence >= THRESHOLDS.place
        ? (PLACES.find((id) => id === where.choice) ?? null)
        : null
    // Sin un sitio claro, lo que la orden nombra de pasada («la media de las notas») no es dónde ponerlo.
    // La explicacion de un tema no va dentro de lo que este seleccionado ni de la funcion que se mira:
    // es un trozo nuevo, al final.
    const { phrase, ...spot }: Placed = teach
      ? { phrase: 'al final del programa' }
      : (apartSpot(place) ?? placeOf(place, place === null ? chosen : target, viewing))
    return done({
      kind: 'do',
      intent: 'componer',
      effect: {
        type: 'compose',
        gen: input.genId,
        place: spot,
        where: phrase,
        // El plan es para lo que de verdad es un programa entero: una pieza (una función, una clase que use
        // lo que ya hay) se escribe directa, sin trocearla en etapas. Un tema que explicar empieza siempre
        // por su plan: es el índice de la explicación.
        outline: teach || (size?.choice === 'esquema' && size.confidence >= 0.6),
        ...(teach ? { teach: true } : {}),
      },
      say: teach
        ? `Te lo explico construyendo un pequeño modelo, paso a paso, ${phrase}.`
        : `Lo escribo ${phrase}.`,
    })
  }

  /**
   * Meter algo en la clase que nombra la orden: si ya existe, se mueve dentro; si no, se crea alrededor de
   * ello, y pasa a ser su primer método.
   */
  const intoClass = (piece: Target): Decision => {
    const name = classIn(input.text) ?? 'MiClase'
    const existing = targets.find(
      (item) =>
        item.node?.kind === 'abstraction.class' &&
        new RegExp(`^class\\s+${name}\\b`, 'i').test(item.head) &&
        item.id !== piece.id,
    )
    if (existing) {
      return done({
        kind: 'do',
        intent: 'mover',
        effect: { type: 'action', action: { type: 'move', id: piece.id, into: existing.id } },
        say: `Muevo ${naming(piece)} dentro de ${naming(existing)}.`,
      })
    }
    return done({
      kind: 'do',
      intent: 'envolver',
      effect: { type: 'action', action: { type: 'wrap', id: piece.id, with: 'class', name } },
      gesture: { kind: 'wrap', id: piece.id },
      say: `Creo la clase ${name} con ${naming(piece)} dentro.`,
    })
  }

  /**
   * Cambiar lo que ya está escrito (lo redacta la IA generativa). `followUp`: la orden retoca lo que se
   * acaba de hacer, así que es ahí donde se mira, diga lo que diga de pasada.
   */
  /** La orden pregunta por lo que este programa ya hace (lo dice el JEV), no por un tema nuevo. */
  const aboutThis = (): boolean => {
    const about = choice(answers.sobre)
    return (
      hasCode &&
      input.genId !== undefined &&
      forced.target === undefined &&
      about?.choice === 'programa' &&
      about.confidence >= 0.5
    )
  }
  /** Se contesta mirando el programa: la IA responde en una frase y se señala dónde. No se escribe nada. */
  const answerIt = (): Decision =>
    done({
      kind: 'do',
      intent: 'explicar',
      effect: { type: 'focus' },
      say: 'Lo miro en tu programa.',
      answer: true,
    })

  const rework = (followUp: boolean): Decision => {
    if (input.genId === undefined) {
      return done({
        kind: 'unknown',
        say: 'Para cambiar lo escrito hace falta una IA generativa: elige un modelo.',
      })
    }
    // «Eso», «lo que acabas de hacer»: lo último que se hizo, antes que lo seleccionado.
    const recent =
      input.last !== undefined &&
      forced.target === undefined &&
      (followUp ||
        (named?.choice === LAST && named.confidence >= THRESHOLDS.target) ||
        target === null)
    const lines = recent
      ? input.last
      : target && !followUp
        ? { from: target.line, to: target.lineEnd }
        : undefined
    return done({
      kind: 'do',
      intent: 'modificar',
      effect: {
        type: 'modify',
        gen: input.genId,
        ...(lines ? { lines } : {}),
        ...(recent
          ? { scope: 'lo último que se hizo' }
          : target && !followUp
            ? { scope: naming(target) }
            : {}),
      },
      ...(target && !recent && !followUp ? { focus: target.id } : {}),
      say: recent
        ? 'Lo cambio en lo último que se hizo.'
        : target && !followUp
          ? `Lo cambio en ${naming(target)}.`
          : 'Miro qué hay que cambiar.',
    })
  }

  // «Mete sumar a una clase Calculadora»: la orden nombra una pieza que existe y dice, con todas las
  // letras, que la meta en una clase. Eso es mover (o crear la clase a su alrededor), lo vea el JEV como
  // lo vea: no se reescribe con la IA lo que se puede cambiar de sitio tal cual, viéndolo.
  const carried = namedBy(input.text, targets).find(
    (item) => item.node?.kind !== 'abstraction.class',
  )
  if (
    forced.intent === undefined &&
    carried !== undefined &&
    classIn(input.text) !== null &&
    (['componer', 'agregar', 'modificar', 'otra'] as Intent[]).includes(intent) &&
    /\b(mete|meter|pon|poner|mueve|mover|lleva|llevar|pasa|pasar|coloca|colocar|incluye|incluir)\b.*\b(a|en|dentro de)\s+(una|la|esa|esta)\s+(nueva\s+)?clase\b/.test(
      input.text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
    )
  ) {
    return intoClass(carried)
  }

  // Un retoque de lo que se acaba de hacer («pero usando la clase») no es una orden nueva, aunque suene a
  // otra cosa: se cambia lo que hay. Lo dice el JEV, mirando la conversación. Solo pisa lo que iba a
  // escribir algo nuevo: mover, envolver, juntar o extraer tienen su propia manera de hacerse (y de verse),
  // y ver, ejecutar o deshacer no cambian nada.
  const follows = answers.sigue?.type === 'noul' ? answers.sigue.noul : 0
  // …salvo que el JEV no esté seguro de ellas: un «mover» al 48 % en una orden que retoca lo anterior
  // («no, pero que se valide en la misma función») no es mover una función entera a otro sitio.
  const structural = (['mover', 'envolver', 'juntar', 'extraer', 'duplicar'] as Intent[]).includes(
    intent,
  )
  if (
    forced.intent === undefined &&
    input.genId !== undefined &&
    follows >= THRESHOLDS.followUp &&
    ((['componer', 'agregar', 'modificar', 'otra'] as Intent[]).includes(intent) ||
      (structural && sure < THRESHOLDS.structural))
  ) {
    return rework(true)
  }

  switch (intent) {
    case 'componer':
      return compose()
    case 'modificar':
      return rework(false)
    case 'ensenar':
      if (aboutThis()) return answerIt()
      // Si lo que se quiere entender resulta ser algo de este programa, se explica ese elemento.
      if (namedTarget) {
        return done({
          kind: 'do',
          intent: 'explicar',
          effect: { type: 'focus' },
          focus: namedTarget.id,
          say: `${naming(namedTarget)}, línea ${namedTarget.line}.`,
          explain: namedTarget.id,
        })
      }
      return compose(true)
    case 'narrar':
      return done({
        kind: 'do',
        intent,
        effect: { type: 'lesson' },
        say: 'Preparo la lección narrada del programa.',
      })
    case 'agregar': {
      // Lo que se pide cambia cómo funciona lo que ya hay: no se cumple con una pieza suelta.
      const fits = choice(answers.encaje)
      if (
        forced.piece === undefined &&
        hasCode &&
        input.genId !== undefined &&
        fits?.choice === 'cambio' &&
        fits.confidence >= 0.5
      ) {
        return rework(false)
      }
      const wanted = choice(answers.pieza)
      const piece =
        forced.piece ??
        (wanted && wanted.confidence >= THRESHOLDS.piece
          ? TEMPLATE_IDS.find((id) => id === wanted.choice)
          : undefined)
      // Con un programa ya escrito y quien lo cambie, una pieza de plantilla solo se pone si está claro cuál
      // es. Quien pide resultados («añade unos gastos de ejemplo») no nombra piezas: con el JEV dudando entre
      // ellas (un diccionario, al 47 %) se pegaba una plantilla sin sentido. Lo resuelve la IA, con el
      // programa delante.
      if (
        forced.piece === undefined &&
        hasCode &&
        input.genId !== undefined &&
        (wanted?.confidence ?? 0) < THRESHOLDS.pieceSure
      ) {
        return rework(false)
      }
      // No es una pieza de las de siempre: si hay quien lo escriba, se escribe; si no, se pregunta cuál.
      if (piece === undefined && forced.piece === undefined && input.genId !== undefined) {
        return compose()
      }
      // No hay plantilla de clase: si se pide una y el JEV, a falta de otra, dice «función», no se
      // pone una función con nombre de clase. La escribe la IA (o, si ya hay programa, lo cambia).
      if (
        forced.piece === undefined &&
        input.genId !== undefined &&
        piece === 'function' &&
        /\bclase\b/i.test(input.text) &&
        !/\b(funci[oó]n|m[eé]todo)\b/i.test(input.text)
      ) {
        return hasCode ? rework(false) : compose()
      }
      // Mirando una clase por dentro, lo que no es un método no va suelto en su cuerpo («pedir el PIN
      // por teclado» es un paso de alguno de sus métodos): que decida la IA, con la clase delante.
      if (
        forced.piece === undefined &&
        input.genId !== undefined &&
        viewing?.node?.kind === 'abstraction.class' &&
        target === null &&
        piece !== 'function'
      ) {
        return rework(false)
      }
      if (piece === undefined) {
        const likely = ranked(answers.pieza, [NO_PIECE]).filter((id): id is TemplateId =>
          (TEMPLATE_IDS as readonly string[]).includes(id),
        )
        const offered = (
          likely.length > 0 ? likely : (['variable', 'for', 'if', 'function'] as const)
        ).slice(0, 4)
        return done({
          kind: 'ask',
          question: '¿Qué añado?',
          options: offered.map((id) => ({
            label: TEMPLATES[id].label,
            force: { ...forced, intent: 'agregar', piece: id },
          })),
        })
      }
      const where = choice(answers.donde)
      const place =
        where && where.confidence >= THRESHOLDS.place
          ? (PLACES.find((id) => id === where.choice) ?? null)
          : null
      const { phrase, ...at }: Placed =
        apartSpot(place) ?? placeOf(place, place === null ? chosen : target, viewing)
      // Un `return` o un `break` no tienen contenido que escribir: son lo que son.
      const writable = !(['break', 'continue'] as TemplateId[]).includes(piece)
      const pending = input.genId !== undefined && writable ? input.genId : undefined
      return done({
        kind: 'do',
        intent,
        effect: {
          type: 'action',
          action: {
            type: 'add',
            template: piece,
            ...at,
            ...(pending === undefined ? {} : { pending }),
          },
        },
        say: `Añado ${TEMPLATES[piece].label.toLowerCase()} ${phrase}.`,
        ...(pending === undefined ? {} : { pending: { id: pending, template: piece } }),
      })
    }

    case 'etapa': {
      if (!target?.node) {
        return done({
          kind: 'unknown',
          say: 'Dime en qué paso empieza la etapa: selecciónalo o nómbralo.',
        })
      }
      const title = titleIn(input.text) ?? 'Nueva etapa'
      return done({
        kind: 'do',
        intent,
        effect: {
          type: 'action',
          action: { type: 'section', id: target.id, title, first: 'Primera etapa' },
        },
        focus: target.id,
        say: `Empiezo la etapa «${title}» en ${naming(target)}.`,
      })
    }

    case 'mover': {
      const end = (id: string): Target | null => {
        const answer = choice(answers[id])
        if (!answer || answer.confidence < THRESHOLDS.target) return null
        return answer.choice === SELECTED
          ? chosen
          : (targets.find((item) => item.ref === answer.choice) ?? null)
      }
      // Lo mismo que al juntar: si el JEV no se decide, valen las que la orden nombra (la primera viaja).
      const said = namedBy(input.text, targets)
      const what =
        end('mover_que') ??
        (forced.target !== undefined ? byId(forced.target) : chosen) ??
        said[0] ??
        null
      const where = end('mover_donde') ?? said.find((item) => item.id !== what?.id) ?? null
      // «Mete sumar en una clase Calculadora», y esa clase aún no existe: se crea alrededor de ella.
      if (
        what?.node &&
        what.node.kind !== 'abstraction.class' &&
        !where &&
        classIn(input.text) !== null
      ) {
        return intoClass(what)
      }
      if (!what?.node || !where?.node || what.id === where.id) {
        return done({ kind: 'unknown', say: 'Dime qué muevo y adónde: nómbralos los dos.' })
      }
      const how = choice(answers.mover_como)?.choice ?? 'dentro'
      const spot =
        how === 'antes'
          ? { before: where.id }
          : how === 'despues'
            ? { after: where.id }
            : { into: where.id }
      const phrase = how === 'antes' ? 'antes de' : how === 'despues' ? 'después de' : 'dentro de'
      return done({
        kind: 'do',
        intent,
        effect: { type: 'action', action: { type: 'move', id: what.id, ...spot } },
        say: `Muevo ${naming(what)} ${phrase} ${naming(where)}.`,
      })
    }

    case 'envolver': {
      if (!target?.node) {
        return done({ kind: 'unknown', say: 'Dime qué envuelvo: selecciónalo o nómbralo.' })
      }
      const into = choice(answers.envolver_en)
      // Si la orden nombra una clase y el JEV no lo tiene claro, es una clase: es lo que dice.
      const kind =
        classIn(input.text) !== null && (into === undefined || into.confidence < 0.8)
          ? 'clase'
          : (into?.choice ?? 'bucle')
      // Una clase no se mete en una clase: si lo que se señala ya lo es, la orden pedía otra cosa.
      if (kind === 'clase') {
        return target.node.kind === 'abstraction.class' ? rework(true) : intoClass(target)
      }
      const wrapper = kind === 'decision' ? 'if' : kind === 'intento' ? 'try' : 'for'
      const name = wrapper === 'if' ? 'una decisión' : wrapper === 'try' ? 'un intento' : 'un bucle'
      return done({
        kind: 'do',
        intent,
        effect: { type: 'action', action: { type: 'wrap', id: target.id, with: wrapper } },
        gesture: { kind: 'wrap', id: target.id },
        say: `Meto ${naming(target)} dentro de ${name}.`,
      })
    }

    case 'duplicar': {
      if (!target?.node) {
        return done({ kind: 'unknown', say: 'Dime qué duplico: selecciónalo o nómbralo.' })
      }
      return done({
        kind: 'do',
        intent,
        effect: { type: 'action', action: { type: 'duplicate', id: target.id } },
        gesture: { kind: 'copy', id: target.id },
        say: `Duplico ${naming(target)}.`,
      })
    }

    case 'juntar':
    case 'extraer': {
      if (input.genId === undefined) {
        return done({
          kind: 'unknown',
          say: 'Para eso hace falta una IA generativa: elige un modelo.',
        })
      }
      const end = (id: string): Target | null => {
        const answer = choice(answers[id])
        if (!answer || answer.confidence < THRESHOLDS.target) return null
        return answer.choice === SELECTED
          ? chosen
          : (targets.find((item) => item.ref === answer.choice) ?? null)
      }
      if (intent === 'extraer') {
        if (!target?.node) {
          return done({ kind: 'unknown', say: 'Dime qué extraigo: selecciónalo o nómbralo.' })
        }
        return done({
          kind: 'do',
          intent,
          effect: {
            type: 'modify',
            gen: input.genId,
            lines: { from: target.line, to: target.lineEnd },
            scope: naming(target),
          },
          gesture: { kind: 'extract', id: target.id },
          say: `Saco ${naming(target)} a una función propia.`,
        })
      }
      // Qué dos piezas: las que el JEV tenga claras y, si no, las que la orden nombra tal cual.
      const said = namedBy(input.text, targets)
      const one = end('mover_que') ?? said[0] ?? target
      const other =
        [end('mover_donde'), ...said].find((item) => item && item.id !== one?.id) ?? null
      if (!one?.node || !other?.node || one.id === other.id) {
        return done({ kind: 'unknown', say: 'Dime qué dos cosas junto: nómbralas.' })
      }
      // Las dos piezas, y lo que haya entre ellas: es lo que la IA tiene que reescribir como una sola.
      return done({
        kind: 'do',
        intent,
        effect: {
          type: 'modify',
          gen: input.genId,
          lines: {
            from: Math.min(one.line, other.line),
            to: Math.max(one.lineEnd, other.lineEnd),
          },
          scope: `${naming(one)} y ${naming(other)}`,
        },
        gesture: { kind: 'merge', id: one.id, to: other.id },
        say: `Junto ${naming(one)} con ${naming(other)}.`,
      })
    }

    case 'eliminar': {
      if (!target) {
        return done({ kind: 'unknown', say: 'Dime qué elimino: selecciónalo o nómbralo.' })
      }
      if (
        forced.intent === undefined &&
        (sure < THRESHOLDS.destructive || targetSure < THRESHOLDS.destructive)
      ) {
        return done({
          kind: 'ask',
          question: `¿Elimino ${naming(target)} (línea ${target.line})?`,
          options: [{ label: 'Sí, eliminar', force: { intent: 'eliminar', target: target.id } }],
          plain: true,
        })
      }
      return done({
        kind: 'do',
        intent,
        effect: {
          type: 'action',
          action: target.node
            ? { type: 'delete', id: target.id }
            : { type: 'unsection', id: target.id },
        },
        say: target.node
          ? `Eliminado: ${naming(target)}.`
          : `Quito la etapa «${target.head}»; su código se queda.`,
      })
    }

    case 'renombrar': {
      if (!target) {
        return done({ kind: 'unknown', say: 'Dime qué renombro: selecciónalo o nómbralo.' })
      }
      if (!target.node) {
        const title = titleIn(input.text) ?? nameIn(input.text)
        if (!title) return done({ kind: 'unknown', say: 'Dime el título nuevo de la etapa.' })
        return done({
          kind: 'do',
          intent,
          effect: { type: 'action', action: { type: 'retitle', id: target.id, title } },
          focus: target.id,
          say: `La etapa pasa a llamarse «${title}».`,
        })
      }
      const from = target.node.provides ?? target.node.label
      const to = nameIn(input.text)
      if (!to || !target.node.names || !(from in target.node.names)) {
        return done({
          kind: 'unknown',
          say: to
            ? `${naming(target)} no define un nombre que se pueda cambiar.`
            : 'Dime el nombre nuevo, por ejemplo: «renombra total a suma».',
        })
      }
      if (to === from) return done({ kind: 'unknown', say: `Ya se llama «${to}».` })
      return done({
        kind: 'do',
        intent,
        effect: { type: 'action', action: { type: 'rename', id: target.id, to, from } },
        focus: target.id,
        say: `«${from}» pasa a llamarse «${to}» en todos los sitios donde se usa.`,
      })
    }

    case 'enfocar':
    case 'explicar':
    case 'plegar': {
      if (intent === 'explicar' && aboutThis()) return answerIt()
      // «Enséñame solo los de más de 20»: el JEV lo leyó como «ir a verlo», pero sin estar seguro (44 %) y
      // sin que la orden señale nada del diagrama. Antes que devolver una pregunta («¿qué quieres que se
      // muestre?»), lo resuelve la IA con el programa delante: quien pide resultados espera que pase algo.
      if (
        intent === 'enfocar' &&
        doubtful &&
        !namedTarget &&
        literal === null &&
        forced.intent === undefined &&
        forced.target === undefined &&
        hasCode &&
        input.genId !== undefined &&
        !LEAVES.test(plainText(input.text))
      ) {
        return rework(false)
      }
      // «Explícame…» algo que la orden no señala en el programa no es una pregunta sobre lo seleccionado:
      // es un tema. Con quien lo redacte, se explica construyendo; no se devuelve un «¿a qué te refieres?».
      if (
        intent === 'explicar' &&
        !namedTarget &&
        forced.target === undefined &&
        input.genId !== undefined
      ) {
        return aboutThis() ? answerIt() : compose(true)
      }
      // «Ver el programa principal», «sal de aquí»: no señala un elemento, pide salir a la vista general.
      if (
        intent === 'enfocar' &&
        !namedTarget &&
        forced.target === undefined &&
        /\b(programa|principal|main|general|inicio|sal|salir|salgamos|fuera|atras|vuelve|volver|todo)\b/.test(
          input.text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
        )
      ) {
        return done({
          kind: 'do',
          intent,
          effect: { type: 'focus' },
          home: true,
          say: 'Volvemos al programa principal.',
        })
      }
      if (!target) {
        return done({ kind: 'unknown', say: 'Dime a qué te refieres: selecciónalo o nómbralo.' })
      }
      if (intent === 'plegar') {
        return done({
          kind: 'do',
          intent,
          effect: { type: 'fold', id: target.id },
          focus: target.id,
          say: `Hecho: ${naming(target)}.`,
        })
      }
      return done({
        kind: 'do',
        intent,
        effect: { type: 'focus' },
        focus: target.id,
        say: `${naming(target)}, línea ${target.line}.`,
        ...(intent === 'explicar' ? { explain: target.id } : {}),
      })
    }

    case 'ejecutar':
      return done({
        kind: 'do',
        intent,
        effect: { type: 'run', ids: namedTarget?.node ? [namedTarget.id] : 'all' },
        ...(namedTarget?.node ? { focus: namedTarget.id } : {}),
        say: namedTarget?.node ? `Ejecuto ${naming(namedTarget)}.` : 'Ejecuto el programa.',
      })
    case 'paso_a_paso':
      return done({
        kind: 'do',
        intent,
        effect: { type: 'trace' },
        say: 'Reproduzco el programa paso a paso.',
      })
    case 'deshacer':
      return done({ kind: 'do', intent, effect: { type: 'undo' }, say: 'Deshecho.' })
    case 'rehacer':
      return done({ kind: 'do', intent, effect: { type: 'redo' }, say: 'Rehecho.' })
    case 'otra':
      // Sin nada mejor que hacer con ello, y con quien lo escriba, se intenta construir.
      return input.genId !== undefined
        ? compose()
        : done({ kind: 'unknown', say: 'Eso todavía no sé hacerlo desde una orden.' })
  }
}
