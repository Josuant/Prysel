import type { Program, TextEdit } from '@prysel/python'
import type { Assets, KernelStatus, RunView } from './runs.ts'
import { LESSON_LIMITS, parseLesson, type Lesson } from './lesson.ts'
import type { Trace } from './trace.ts'

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

export type WebviewMessage =
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

export type HostMessage =
  | ReadyMessage
  | EditMessage
  | RunMessage
  | InterruptMessage
  | RestartMessage
  | TraceMessage
  | NewLessonMessage
  | UndoMessage
  | NoteMoveMessage

/** Tope de lo que un solo cambio puede reescribir: un mensaje absurdo no se aplica. */
const MAX_EDITS = 64
const MAX_TEXT = 200_000
const MAX_RUN_IDS = 500

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
  if (type === 'newLesson') return { type: 'newLesson' }
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
