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
  modificar:
    'Cambiar código que YA está escrito: que haga otra cosa, corregirlo, refactorizarlo, simplificarlo, cambiar un valor o una operación («ahora que reste en lugar de sumar», «refactoriza esto»).',
  renombrar: 'Solo cambiar el nombre de una variable, una función o una etapa que ya existe.',
  enfocar: 'Ir a un elemento, mostrarlo, buscarlo o llevar la vista hasta él, sin cambiar nada.',
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
  /** Por debajo, el sitio es el de siempre: dentro o detrás de lo seleccionado, o al final. */
  place: 0.4,
  target: 0.45,
  /** Lo que destruye (eliminar) pide más certeza, en la intención y en el objetivo. */
  destructive: 0.7,
  /** Por encima, la orden son varias órdenes seguidas: se parte y se decide cada una. */
  several: 0.6,
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
    }
  | {
      kind: 'ask'
      question: string
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
  const state = {
    orden: input.text,
    viendo: viewing ? `la función «${viewing.head}»` : 'el programa entero',
    seleccionado: chosen ? chosen.description : 'nada',
  }
  const questions: Record<string, JevQuestion> = {}
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
    if (input.genId !== undefined) {
      questions.alcance = {
        type: 'choice',
        instructions: 'Si la `orden` pide escribir código nuevo, ¿cuánto es?',
        criteria: {
          directo:
            'Poco: una función sencilla o unas pocas sentencias (hasta unas seis). Se escribe directamente.',
          esquema:
            'Bastante: un programa o un algoritmo con varias fases. Conviene pensar primero sus etapas y luego detallar cada una.',
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
  const guess: Intent | undefined =
    !doubtful || input.genId === undefined
      ? undefined
      : likely[0] !== undefined && likely[0] !== 'eliminar' && sure >= 0.25
        ? likely[0]
        : likely[0] === 'eliminar'
          ? undefined
          : 'componer'
  const intent = guess ?? heard
  if (guess === undefined && (intent === undefined || sure < THRESHOLDS.intent)) {
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
  const target = forced.target !== undefined ? byId(forced.target) : (namedTarget ?? chosen)
  /** Con cuánta certeza se sabe el objetivo: lo que el usuario eligió a mano es seguro. */
  const targetSure =
    forced.target !== undefined || (namedTarget === null && chosen !== null)
      ? 1
      : (named?.confidence ?? 0)
  const viewing = byId(input.focus)

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
    const { phrase, ...spot } = teach
      ? { phrase: 'al final del programa' }
      : placeOf(place, place === null ? chosen : target, viewing)
    return done({
      kind: 'do',
      intent: 'componer',
      effect: {
        type: 'compose',
        gen: input.genId,
        place: spot,
        where: phrase,
        // Por defecto, primero el plan: solo lo claramente pequeño va directo a los pasos. Un tema que
        // explicar empieza siempre por su plan: es el índice de la explicación.
        outline: teach || !(size?.choice === 'directo' && size.confidence >= 0.6),
        ...(teach ? { teach: true } : {}),
      },
      say: teach
        ? `Te lo explico construyendo un pequeño modelo, paso a paso, ${phrase}.`
        : `Lo escribo ${phrase}.`,
    })
  }

  switch (intent) {
    case 'componer':
      return compose()
    case 'modificar': {
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
        ((named?.choice === LAST && named.confidence >= THRESHOLDS.target) || target === null)
      const lines = recent
        ? input.last
        : target
          ? { from: target.line, to: target.lineEnd }
          : undefined
      return done({
        kind: 'do',
        intent,
        effect: {
          type: 'modify',
          gen: input.genId,
          ...(lines ? { lines } : {}),
          ...(recent
            ? { scope: 'lo último que se hizo' }
            : target
              ? { scope: naming(target) }
              : {}),
        },
        ...(target && !recent ? { focus: target.id } : {}),
        say: recent
          ? 'Lo cambio en lo último que se hizo.'
          : target
            ? `Lo cambio en ${naming(target)}.`
            : 'Miro qué hay que cambiar.',
      })
    }
    case 'ensenar':
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
      const wanted = choice(answers.pieza)
      const piece =
        forced.piece ??
        (wanted && wanted.confidence >= THRESHOLDS.piece
          ? TEMPLATE_IDS.find((id) => id === wanted.choice)
          : undefined)
      // No es una pieza de las de siempre: si hay quien lo escriba, se escribe; si no, se pregunta cuál.
      if (piece === undefined && forced.piece === undefined && input.genId !== undefined) {
        return compose()
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
      const { phrase, ...at } = placeOf(place, place === null ? chosen : target, viewing)
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
      // «Explícame…» algo que la orden no señala en el programa no es una pregunta sobre lo seleccionado:
      // es un tema. Con quien lo redacte, se explica construyendo; no se devuelve un «¿a qué te refieres?».
      if (
        intent === 'explicar' &&
        !namedTarget &&
        forced.target === undefined &&
        input.genId !== undefined
      ) {
        return compose(true)
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
