import type { Program, TextEdit } from '@prysel/python'
import type { Assets, KernelStatus, RunView } from './runs.ts'
import { LESSON_LIMITS, parseLesson, type Lesson } from './lesson.ts'
import type { Trace } from './trace.ts'
import type { CallEntry } from './calls.ts'
import type { Gist } from './gist/gist.ts'
import {
  INTENTS,
  type Decision,
  type Directive,
  type Evidence,
  type Forced,
  type Intent,
} from './jev/engine.ts'
import { TEMPLATE_IDS, type TemplateId } from '@prysel/morphology'

/**
 * Protocolo de mensajes entre la extensión y el webview.
 * Se valida en ambos extremos: un mensaje que no pasa la comprobación se descarta,
 * nunca se interpreta a ciegas.
 */

export type Theme = 'light' | 'dark'

/** Extensión → webview. */
export interface UpdateMessage {
  type: 'update'
  program: Program | null
  /** Nombre del archivo analizado, para mostrarlo en la cabecera. */
  file?: string
  /**
   * La versión del documento que se analizó. Los desplazamientos del programa valen solo para
   * ella: una edición que vuelve al anfitrión la lleva, y si el texto ha cambiado, se descarta.
   */
  version?: number
}

export interface ThemeMessage {
  type: 'theme'
  theme: Theme
}

/**
 * Extensión → webview: cómo está cada sentencia de primer nivel (por el id de su nodo) y el motor.
 * `version` es la del texto al que se refieren los ids: si el documento ya cambió, el lienzo los
 * descarta y espera el siguiente.
 */
export interface RunsMessage {
  type: 'runs'
  views: Record<string, RunView>
  kernel: KernelStatus
  /** Por qué el motor no arrancó o se cayó, si es el caso. */
  problem: string | null
  version: number
}

/** Extensión → webview: las imágenes de una ejecución, que solo se mandan una vez (por su `seq`). */
export interface AssetsMessage {
  type: 'assets'
  seq: number
  assets: Assets
}

/**
 * Extensión → webview: cómo va la grabación de la traza de un programa. `version` es la del texto que se
 * trazó: si el documento ya cambió, la traza no corresponde a lo que hay y el lienzo la descarta.
 */
export interface TraceResultMessage {
  type: 'trace'
  version: number
  status: 'running' | 'done' | 'failed'
  trace: Trace | null
  /** Por qué no se pudo grabar, si falló. */
  message?: string
}

/**
 * Extensión → webview: el guion de la lección del archivo que se enseña (el `.lesson.json` que hay junto
 * al `.py`), o por qué no se pudo leer. Sin guion (`lesson: null` y sin `error`), no hay lección.
 */
export interface LessonMessage {
  type: 'lesson'
  /** El archivo al que pertenece (el mismo nombre que lleva su `update`). */
  file: string
  lesson: Lesson | null
  error?: string
}

/**
 * Extensión → webview: cuántos cambios hechos desde el lienzo se pueden deshacer y rehacer ahora (en el
 * documento que se enseña). Es lo que enciende o apaga los botones.
 */
export interface HistoryMessage {
  type: 'history'
  undo: number
  redo: number
}

/**
 * Extensión → webview: lo que el motor JEV decidió para una orden (`id`: la que mandó el lienzo). `version`
 * es la del texto sobre el que se decidió: si el documento ya cambió, el lienzo no la ejecuta.
 */
export interface DecisionMessage extends Decision {
  type: 'decision'
  id: number
  version: number
}

/**
 * Extensión → webview: el contenido de una pieza que nació «generándose» ya está escrito (o no se pudo:
 * la plantilla se queda). `say` es lo que se dice de ella; `line`, dónde quedó.
 */
export interface GeneratedMessage {
  type: 'generated'
  gen: string
  ok: boolean
  say?: string
  error?: string
  line?: number
  /** Si lo juzgó el JEV (una orden compleja): lo que contestó. */
  evidence?: Evidence[]
  /** Lo que tardó el JEV en total, entre paso y paso. */
  jevMs?: number
  /** Ya no queda nada en marcha de esa orden. */
  done?: boolean
  /** Lo construido es una sola función o clase (la línea de su cabecera): la vista entra en ella. */
  enter?: number
}

/**
 * Extensión → webview: un paso de una construcción ya está escrito (el programa nuevo llegó justo antes).
 * El lienzo lo hace aparecer, lleva la cámara a él y dice su frase.
 */
export interface StepMessage {
  type: 'step'
  gen: string
  /** Qué paso es (desde 1). */
  index: number
  say: string
  /** La línea donde quedó su sentencia. */
  line: number
  /** Si lo lleva, el lienzo avisa (`spoken`) cuando ha terminado de decir su frase. */
  seq?: number
  /**
   * El trozo exacto del código de la pieza que se subraya mientras se dice (lo elige el JEV), con sus
   * suplentes por orden: se subraya el primero que esté escrito en el nodo.
   */
  mark?: string[]
  /**
   * Qué le pasa: aparece (`born`, por defecto), llega su explicación (`told`: ya estaba), cambia
   * (`changed`) o está a punto de irse (`leaving`).
   */
  effect?: 'born' | 'told' | 'changed' | 'leaving'
  /** La cámara enseña el conjunto, no solo la pieza (lo decide el JEV). */
  wide?: boolean
  /**
   * La pieza entra en una parte del plan que se deja plegada: se señala la tarjeta de esa parte (la intención),
   * no se abre para enseñar la línea. Quien quiera el detalle, abre la tarjeta.
   */
  folded?: boolean
  /** La línea donde se queda la cámara mientras la pieza entra: la cabecera de lo que se construye. */
  anchor?: number
}

/**
 * Extensión → webview: lo que el usuario parece estar pidiendo, por lo que lleva dicho (aún no ha acabado
 * la frase). El lienzo dibuja su hueco y lo va actualizando palabra a palabra.
 */
export interface PreviewMessage {
  type: 'preview'
  /** Qué clase de cosa es (`funcion`, `clase`, `programa`…; `nada`: aún no se sabe). */
  kind: string
  /** Lo que lleva dicho. */
  text: string
  /** Si lo dicho es ya una orden entera (1) o la frase está a medias (0). Lo dice el JEV. */
  complete?: number
}

/**
 * Extensión → webview: una consulta a un modelo (a la IA que redacta o al JEV que decide) empezó, avanzó
 * o acabó. El lienzo las enseña en su pestaña «Consultas».
 */
export interface CallMessage {
  type: 'call'
  entry: CallEntry
}

/** Extensión → webview: en qué se está pensando ahora, mientras no hay nada nuevo que ver. */
export interface ProgressMessage {
  type: 'progress'
  gen: string
  text: string
}

/** Extensión → webview: qué IA redacta y qué motor decide ahora (`null`: no hay, falta su clave). */
export interface ModelsMessage {
  type: 'models'
  ai: string | null
  jev: string | null
}

/** Extensión → webview: algo que decir en voz alta (una explicación que tardó en redactarse). */
export interface SayMessage {
  type: 'say'
  text: string
  /** El elemento del que se habla: la cámara va a él. */
  focus?: string
  /** Si lo lleva, el lienzo avisa (`spoken`) cuando ha terminado de decirlo. */
  seq?: number
  /**
   * Un comentario al margen de lo que se está escribiendo: sale como subtítulo y se dice solo si no se está
   * diciendo otra cosa (no corta a nadie, ni nadie espera por él).
   */
  aside?: boolean
}

/**
 * Extensión → webview: «qué hace» cada función, con una muestra ejecutada de verdad. `version` es la del
 * texto del que salió; cada una lleva además el resumen de su función, y solo vale mientras coincida.
 */
export interface GistsMessage {
  type: 'gists'
  version: number
  gists: Gist[]
}

export type WebviewMessage =
  | GistsMessage
  | DecisionMessage
  | GeneratedMessage
  | StepMessage
  | ProgressMessage
  | PreviewMessage
  | CallMessage
  | ModelsMessage
  | SayMessage
  | UpdateMessage
  | ThemeMessage
  | RunsMessage
  | AssetsMessage
  | TraceResultMessage
  | LessonMessage
  | HistoryMessage

/** Webview → extensión. */
export interface ReadyMessage {
  type: 'ready'
}

/** El usuario cambió un campo en el lienzo: estas son las ediciones de texto que lo reflejan. */
export interface EditMessage {
  type: 'edit'
  version: number
  edits: TextEdit[]
}

/** Ejecutar nodos (con lo que necesitan y no está al día) o todo el programa. */
export interface RunMessage {
  type: 'run'
  version: number
  ids: string[] | 'all'
}

/** Cortar lo que se ejecuta. */
export interface InterruptMessage {
  type: 'interrupt'
}

/** Empezar de cero: se pierde el espacio de nombres del motor. */
export interface RestartMessage {
  type: 'restart'
}

/** Grabar y enseñar la traza del archivo entero: qué pasa línea a línea. */
export interface TraceMessage {
  type: 'trace'
  version: number
}

/** Crear (o abrir) el guion de la lección del archivo. */
export interface NewLessonMessage {
  type: 'newLesson'
}

/** Pedir a la IA las etapas (comentarios de sección) de los bloques largos que no las tienen. */
export interface ProposeSectionsMessage {
  type: 'proposeSections'
}

/** Deshacer o rehacer el último cambio hecho desde el lienzo. */
export interface UndoMessage {
  type: 'undo' | 'redo'
}

/**
 * Una nota de la lección se dejó a mano en otro sitio (`offset`: cuánto se aparta del que le da el margen),
 * o se devolvió al suyo (`offset` nulo). Se guarda en el guion, junto a esa nota.
 */
export interface NoteMoveMessage {
  type: 'noteMove'
  /** El id del momento del guion al que pertenece la nota. */
  beat: string
  offset: { x: number; y: number } | null
}

/**
 * Una orden escrita (o dictada) en el lienzo: el motor JEV decide qué hacer con ella. Lleva lo que el
 * lienzo sabe y el anfitrión no: qué está seleccionado y qué función se está viendo. `force` es lo que el
 * usuario ya aclaró al contestar una pregunta del motor.
 */
export interface CommandMessage {
  type: 'command'
  id: number
  text: string
  version: number
  selected: string | null
  focus: string | null
  force?: Forced
}

/** Guardar la clave de TypeSafe (la pide VS Code en su propia caja: el lienzo nunca la ve). */
export interface JevKeyMessage {
  type: 'jevKey'
}

/**
 * El lienzo terminó de decir en voz alta lo que se le mandó con ese `seq` (o no lo dijo: la voz está apagada).
 * Es lo que deja al anfitrión esperar a que se acabe de hablar antes de enseñar lo siguiente.
 */
export interface SpokenMessage {
  type: 'spoken'
  seq: number
  spoke: boolean
}

/** Detener lo que una orden esté construyendo paso a paso. */
export interface StopOrderMessage {
  type: 'stopOrder'
}

/**
 * Deshacer la última orden entera («no, eso no»): todo lo que escribió, aunque fueran muchos pasos, de una
 * vez. No es el deshacer del lienzo, que va cambio a cambio.
 */
export interface UndoOrderMessage {
  type: 'undoOrder'
}

/**
 * El usuario ha empezado a hablar (`on`) o ha dejado de hacerlo sin decir nada que valga. Mientras habla, lo
 * que se esté construyendo se queda quieto: va a decir algo, y puede cambiarlo todo.
 */
export interface ListeningMessage {
  type: 'listening'
  on: boolean
  /** Lo que lleva dicho hasta ahora: con ello se va adelantando qué está pidiendo. */
  text?: string
}

/** Olvidar las consultas apuntadas. */
export interface ClearCallsMessage {
  type: 'clearCalls'
}

/** Abrir el selector de modelos. */
export interface PickModelMessage {
  type: 'pickModel'
}

export type HostMessage =
  | CommandMessage
  | JevKeyMessage
  | StopOrderMessage
  | UndoOrderMessage
  | ListeningMessage
  | SpokenMessage
  | ClearCallsMessage
  | PickModelMessage
  | ReadyMessage
  | EditMessage
  | RunMessage
  | InterruptMessage
  | RestartMessage
  | TraceMessage
  | NewLessonMessage
  | ProposeSectionsMessage
  | UndoMessage
  | NoteMoveMessage

/** Tope de lo que un solo cambio puede reescribir: un mensaje absurdo no se aplica. */
const MAX_EDITS = 64
const MAX_TEXT = 200_000
const MAX_RUN_IDS = 500
/** Una orden es una frase: lo que pase de aquí no lo es. */
export const MAX_COMMAND = 400
const MAX_ID = 200

const DIRECTIVE_KINDS = ['do', 'ask', 'several', 'ignored', 'unknown', 'failed']

/** La directiva llega del anfitrión: se comprueba su forma por fuera; lo de dentro lo valida quien lo usa. */
function isDirective(value: unknown): value is Directive {
  if (typeof value !== 'object' || value === null) return false
  const { kind, say, effect, question, options } = value as {
    kind?: unknown
    say?: unknown
    effect?: unknown
    question?: unknown
    options?: unknown
  }
  if (typeof kind !== 'string' || !DIRECTIVE_KINDS.includes(kind)) return false
  if (kind === 'ask') return typeof question === 'string' && Array.isArray(options)
  if (typeof say !== 'string') return false
  return kind !== 'do' || (typeof effect === 'object' && effect !== null)
}

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= MAX_ID

/** Lo que el usuario aclaró: solo lo que se conoce, y nada más. */
function parseForced(value: unknown): Forced | null {
  if (typeof value !== 'object' || value === null) return null
  const { intent, piece, target } = value as { intent?: unknown; piece?: unknown; target?: unknown }
  if (intent !== undefined && !(INTENTS as readonly unknown[]).includes(intent)) return null
  if (piece !== undefined && !(TEMPLATE_IDS as readonly unknown[]).includes(piece)) return null
  if (target !== undefined && !isId(target)) return null
  return {
    ...(intent === undefined ? {} : { intent: intent as Intent }),
    ...(piece === undefined ? {} : { piece: piece as TemplateId }),
    ...(target === undefined ? {} : { target }),
  }
}

function isEdit(value: unknown): value is TextEdit {
  if (typeof value !== 'object' || value === null) return false
  const { start, end, text } = value as Partial<TextEdit>
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    typeof text === 'string' &&
    text.length <= MAX_TEXT &&
    (start as number) >= 0 &&
    (end as number) >= (start as number)
  )
}

function isProgram(value: unknown): value is Program {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { nodes?: unknown; edges?: unknown; unsupported?: unknown }
  return (
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges) &&
    Array.isArray(candidate.unsupported)
  )
}

export function parseWebviewMessage(value: unknown): WebviewMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const type = (value as { type?: unknown }).type
  if (type === 'update') {
    const program = (value as { program?: unknown }).program
    if (program === null || isProgram(program)) return value as UpdateMessage
    return null
  }
  if (type === 'runs') {
    const { views, kernel, problem, version } = value as Partial<RunsMessage>
    const statuses = ['stopped', 'starting', 'idle', 'busy', 'dead']
    if (typeof views !== 'object' || views === null || Array.isArray(views)) return null
    if (typeof kernel !== 'string' || !statuses.includes(kernel)) return null
    if (problem !== null && typeof problem !== 'string') return null
    if (!Number.isInteger(version)) return null
    return value as RunsMessage
  }
  if (type === 'assets') {
    const { seq, assets } = value as Partial<AssetsMessage>
    if (!Number.isInteger(seq) || typeof assets !== 'object' || assets === null) return null
    if (!Array.isArray(assets.figures) || typeof assets.images !== 'object') return null
    return value as AssetsMessage
  }
  if (type === 'lesson') {
    const { file, lesson, error } = value as { file?: unknown; lesson?: unknown; error?: unknown }
    if (typeof file !== 'string') return null
    if (error !== undefined && typeof error !== 'string') return null
    if (lesson === null || lesson === undefined) {
      return { type: 'lesson', file, lesson: null, ...(error === undefined ? {} : { error }) }
    }
    // El guion llega del disco: se vuelve a validar aquí, no se da por bueno lo que manda quien envía.
    const parsed = parseLesson(lesson)
    return parsed.ok ? { type: 'lesson', file, lesson: parsed.lesson } : null
  }
  if (type === 'trace') {
    const { version, status, trace, message } = value as Partial<TraceResultMessage>
    if (!Number.isInteger(version)) return null
    if (status !== 'running' && status !== 'done' && status !== 'failed') return null
    if (message !== undefined && typeof message !== 'string') return null
    if (trace !== null && trace !== undefined) {
      const { events, truncated, error, output } = trace as Partial<Trace>
      if (!Array.isArray(events) || typeof truncated !== 'boolean' || typeof output !== 'string') {
        return null
      }
      if (error !== null && typeof error !== 'object') return null
    }
    return value as TraceResultMessage
  }
  if (type === 'decision') {
    const { id, version, directive, evidence, engine, jevMs } = value as Partial<DecisionMessage>
    if (!Number.isInteger(id) || !Number.isInteger(version)) return null
    if (!isDirective(directive) || !Array.isArray(evidence)) return null
    if (typeof engine !== 'string' || typeof jevMs !== 'number') return null
    return value as DecisionMessage
  }
  if (type === 'generated') {
    const { gen, ok, say, error, line } = value as Partial<GeneratedMessage>
    if (typeof gen !== 'string' || typeof ok !== 'boolean') return null
    const judged = (value as { evidence?: unknown }).evidence
    if (judged !== undefined && !Array.isArray(judged)) return null
    if (say !== undefined && typeof say !== 'string') return null
    if (error !== undefined && typeof error !== 'string') return null
    if (line !== undefined && !Number.isInteger(line)) return null
    return value as GeneratedMessage
  }
  if (type === 'step') {
    const { gen, index, say, line, wide } = value as Partial<StepMessage>
    if (typeof gen !== 'string' || typeof say !== 'string') return null
    if (!Number.isInteger(index) || !Number.isInteger(line)) return null
    if (wide !== undefined && typeof wide !== 'boolean') return null
    const effect = (value as { effect?: unknown }).effect
    if (
      effect !== undefined &&
      !['born', 'told', 'changed', 'leaving'].includes(effect as string)
    ) {
      return null
    }
    return value as StepMessage
  }
  if (type === 'call') {
    const entry = (value as { entry?: unknown }).entry as Partial<CallEntry> | null | undefined
    if (typeof entry !== 'object' || entry === null) return null
    if (!Number.isInteger(entry.id) || typeof entry.at !== 'number') return null
    if (entry.kind !== 'ia' && entry.kind !== 'jev') return null
    if (typeof entry.model !== 'string') return null
    if (!['running', 'done', 'failed'].includes(entry.status as string)) return null
    return { type: 'call', entry: entry as CallEntry }
  }
  if (type === 'gists') {
    const { version, gists } = value as Partial<GistsMessage>
    if (!Number.isInteger(version) || !Array.isArray(gists)) return null
    const sound = gists.every(
      (gist: Partial<Gist> | null) =>
        typeof gist === 'object' &&
        gist !== null &&
        typeof gist.id === 'string' &&
        typeof gist.name === 'string' &&
        typeof gist.hash === 'string' &&
        typeof gist.status === 'string',
    )
    return sound ? { type: 'gists', version: version as number, gists } : null
  }
  if (type === 'progress') {
    const { gen, text } = value as Partial<ProgressMessage>
    if (typeof gen !== 'string' || typeof text !== 'string' || text === '') return null
    return { type: 'progress', gen, text }
  }
  if (type === 'preview') {
    const { kind, text } = value as Partial<PreviewMessage>
    const complete = (value as { complete?: unknown }).complete
    return typeof kind === 'string' && typeof text === 'string'
      ? { type: 'preview', kind, text, ...(typeof complete === 'number' ? { complete } : {}) }
      : null
  }
  if (type === 'models') {
    const { ai, jev } = value as Partial<ModelsMessage>
    if (ai !== null && typeof ai !== 'string') return null
    if (jev !== null && typeof jev !== 'string') return null
    return { type: 'models', ai, jev }
  }
  if (type === 'say') {
    const { text, focus } = value as Partial<SayMessage>
    if (typeof text !== 'string' || text === '') return null
    if (focus !== undefined && typeof focus !== 'string') return null
    return value as SayMessage
  }
  if (type === 'theme') {
    const theme = (value as { theme?: unknown }).theme
    if (theme === 'light' || theme === 'dark') return value as ThemeMessage
    return null
  }
  if (type === 'history') {
    const { undo, redo } = value as { undo?: unknown; redo?: unknown }
    const count = (n: unknown) => Number.isInteger(n) && (n as number) >= 0
    return count(undo) && count(redo)
      ? { type: 'history', undo: undo as number, redo: redo as number }
      : null
  }
  return null
}

export function parseHostMessage(value: unknown): HostMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const type = (value as { type?: unknown }).type
  if (type === 'ready') return value as ReadyMessage
  if (type === 'edit') {
    const { version, edits } = value as { version?: unknown; edits?: unknown }
    if (!Number.isInteger(version) || !Array.isArray(edits)) return null
    if (edits.length === 0 || edits.length > MAX_EDITS || !edits.every(isEdit)) return null
    return { type: 'edit', version: version as number, edits }
  }
  if (type === 'run') {
    const { version, ids } = value as { version?: unknown; ids?: unknown }
    if (!Number.isInteger(version)) return null
    if (ids === 'all') return { type: 'run', version: version as number, ids }
    const valid =
      Array.isArray(ids) &&
      ids.length > 0 &&
      ids.length <= MAX_RUN_IDS &&
      ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)
    return valid ? { type: 'run', version: version as number, ids: ids as string[] } : null
  }
  if (type === 'trace') {
    const { version } = value as { version?: unknown }
    return Number.isInteger(version) ? { type: 'trace', version: version as number } : null
  }
  if (type === 'command') {
    const { id, text, version, selected, focus, force } = value as Record<string, unknown>
    if (!Number.isInteger(id) || !Number.isInteger(version)) return null
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_COMMAND) return null
    if (selected !== null && !isId(selected)) return null
    if (focus !== null && !isId(focus)) return null
    const forced = force === undefined ? undefined : parseForced(force)
    if (forced === null) return null
    return {
      type: 'command',
      id: id as number,
      text: text.trim(),
      version: version as number,
      selected,
      focus,
      ...(forced === undefined ? {} : { force: forced }),
    }
  }
  if (type === 'jevKey') return { type: 'jevKey' }
  if (type === 'stopOrder') return { type: 'stopOrder' }
  if (type === 'undoOrder') return { type: 'undoOrder' }
  if (type === 'listening') {
    const { on, text } = value as { on?: unknown; text?: unknown }
    if (typeof on !== 'boolean') return null
    return typeof text === 'string' && text !== ''
      ? { type: 'listening', on, text: text.slice(0, MAX_COMMAND) }
      : { type: 'listening', on }
  }
  if (type === 'spoken') {
    const { seq, spoke } = value as { seq?: unknown; spoke?: unknown }
    return Number.isInteger(seq) && typeof spoke === 'boolean'
      ? { type: 'spoken', seq: seq as number, spoke }
      : null
  }
  if (type === 'clearCalls') return { type: 'clearCalls' }
  if (type === 'pickModel') return { type: 'pickModel' }
  if (type === 'newLesson') return { type: 'newLesson' }
  if (type === 'proposeSections') return { type: 'proposeSections' }
  if (type === 'interrupt') return { type: 'interrupt' }
  if (type === 'restart') return { type: 'restart' }
  if (type === 'undo' || type === 'redo') return { type }
  if (type === 'noteMove') {
    const { beat, offset } = value as { beat?: unknown; offset?: unknown }
    if (typeof beat !== 'string' || beat === '' || beat.length > 200) return null
    if (offset === null) return { type: 'noteMove', beat, offset: null }
    const { x, y } = (offset ?? {}) as { x?: unknown; y?: unknown }
    const coordinate = (n: unknown) =>
      typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= LESSON_LIMITS.offset
    return coordinate(x) && coordinate(y)
      ? { type: 'noteMove', beat, offset: { x: x as number, y: y as number } }
      : null
  }
  return null
}
