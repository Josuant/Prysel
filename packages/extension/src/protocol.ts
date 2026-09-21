import type { Program, TextEdit } from '@prysel/python'

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

export type WebviewMessage = UpdateMessage | ThemeMessage

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

export type HostMessage = ReadyMessage | EditMessage

/** Tope de lo que un solo cambio puede reescribir: un mensaje absurdo no se aplica. */
const MAX_EDITS = 64
const MAX_TEXT = 200_000

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
  if (type === 'theme') {
    const theme = (value as { theme?: unknown }).theme
    if (theme === 'light' || theme === 'dark') return value as ThemeMessage
    return null
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
  return null
}
