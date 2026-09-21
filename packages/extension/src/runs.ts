import type { Summary } from './kernel.ts'

/**
 * Lo que el lienzo sabe de las ejecuciones: tipos puros que cruzan del anfitrión al webview. Sin
 * `vscode` ni motor, para que los importe cualquiera de los dos extremos.
 */

/** El motor: parado, arrancando, libre, ocupado o caído (su espacio de nombres se perdió). */
export type KernelStatus = 'stopped' | 'starting' | 'idle' | 'busy' | 'dead'

/** En qué está una sentencia: nunca ejecutada, ejecutándose, al día, desactualizada o con error. */
export type RunState = 'never' | 'running' | 'fresh' | 'stale' | 'error'

/** Lo pesado de una ejecución (imágenes en Base64): se manda una vez, no con cada cambio. */
export interface Assets {
  figures: { mime: string; data: string }[]
  /** La miniatura de cada nombre que es una imagen. */
  images: Record<string, string>
}

export interface RunFailure {
  name: string
  message: string
  /** La línea del archivo donde falló, si se sabe. */
  line: number | null
  traceback: string
}

/** Lo que enseña el lienzo de una sentencia de primer nivel. */
export interface RunView {
  state: RunState
  /** El hash del texto de la sentencia: es lo que ata un visor a ella aunque cambie de línea. */
  hash: string
  /** El orden global de ejecución: también es la clave de sus `Assets`. */
  seq?: number
  ms?: number
  /** El resumen de cada nombre que la sentencia definió o cambió (sin imágenes). */
  values?: Record<string, Summary>
  /** El valor de la última expresión, si la había. */
  result?: Summary
  stdout?: string
  stderr?: string
  /** Hay imágenes o figuras: se piden por `seq`. */
  assets?: boolean
  error?: RunFailure
}

/** Un resumen legible en una línea: `ndarray (200, 2) float64`, `DataFrame 1200×8`, `list · 3`. */
export function describeSummary(summary: Summary): string {
  const shape = summary.shape
  const dims = shape
    ? shape.length === 2
      ? `${shape[0]}×${shape[1]}`
      : `(${shape.join(', ')})`
    : ''
  const parts = [summary.type]
  if (dims) parts.push(dims)
  else if (summary.length !== undefined) parts.push(`${summary.length}`)
  else if (summary.repr !== undefined && summary.repr.length <= 24) parts.push(summary.repr)
  if (summary.dtype && !summary.table) parts.push(summary.dtype)
  if (summary.device && summary.device !== 'cpu') parts.push(summary.device)
  return parts.join(' ')
}

/** Lo corto que acompaña al chip de un valor: su forma (`200×2`) o cuántos elementos tiene (`#3`). Los escalares, nada. */
export function chipHint(summary: Summary): string | undefined {
  const shape = summary.shape
  if (shape) return shape.length === 2 ? `${shape[0]}×${shape[1]}` : `(${shape.join(', ')})`
  if (summary.length !== undefined && summary.type !== 'str') return `#${summary.length}`
  return undefined
}

/** Lo que enseña el pie de un nodo ejecutado: cuánto tardó y qué valor dejó. */
export function runCaption(view: RunView): string | undefined {
  if (view.state === 'never') return undefined
  if (view.state === 'running') return 'ejecutando…'
  if (view.state === 'error') return `falló: ${view.error?.name ?? 'error'}`
  const values = Object.entries(view.values ?? {})
  const parts: string[] = []
  if (view.state === 'stale') parts.push('desactualizado')
  if (view.ms !== undefined)
    parts.push(view.ms < 1000 ? `${Math.round(view.ms)} ms` : `${(view.ms / 1000).toFixed(1)} s`)
  if (values.length === 1 && values[0]) parts.push(describeSummary(values[0][1]))
  else if (values.length > 1) parts.push(`${values.length} valores`)
  return parts.join(' · ')
}
