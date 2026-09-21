import type { ViewerContent } from '@prysel/ui'
import type { Summary } from '../../src/kernel.ts'
import { describeSummary, type Assets, type RunView } from '../../src/runs.ts'

/**
 * Los visores fijados en el lienzo. Un visor no es código: es una ventana con el valor que una
 * sentencia dejó al ejecutarse, y solo vive en el lienzo (se recuerda en el estado del webview, nunca
 * en el archivo). Se ata a una sentencia por lo que dice de ella —su texto— y, si se editó en el mismo
 * sitio, por su id: sigue a la sentencia aunque cambie de línea, y aguanta que se edite por dentro.
 */

/** A qué valor está atado un visor. `name` es una variable, o `figura:N` para la N-ésima figura. */
export interface PinKey {
  id: string
  hash: string
  name: string
}

export const FIGURE = 'figura:'

export const pinNodeId = (key: PinKey): string => `pin:${key.hash}:${key.name}`
export const isPinNode = (id: string): boolean => id.startsWith('pin:')
export const sameKey = (a: PinKey, b: PinKey): boolean => a.hash === b.hash && a.name === b.name

/** Tope de visores recordados por archivo: un estado que crece sin fin no sirve a nadie. */
export const MAX_PINS = 40

export interface ResolvedPin {
  key: PinKey
  /** La sentencia a la que está atado ahora mismo. */
  statement: string
  view: RunView
}

/** A qué sentencia sigue cada visor: la que conserva su texto (aunque se haya movido) o, si se editó, la de su mismo id. */
export function resolvePins(
  pins: readonly PinKey[],
  runs: Readonly<Record<string, RunView>>,
): ResolvedPin[] {
  const entries = Object.entries(runs)
  return pins.flatMap((key) => {
    const found =
      entries.find(([, view]) => view.hash === key.hash) ?? entries.find(([id]) => id === key.id)
    return found ? [{ key, statement: found[0], view: found[1] }] : []
  })
}

/** Lo que vale la pena ver de una ejecución: los valores con forma, y las figuras. Un módulo o una función, no. */
export function viewableOf(view: RunView, assets: Assets | undefined): string[] {
  const skip = new Set(['module', 'function', 'NoneType', 'type', 'builtin_function_or_method'])
  const names = Object.entries(view.values ?? {})
    .filter(([, summary]) => !skip.has(summary.type))
    .map(([name]) => name)
  const figures = (assets?.figures ?? []).map((_, index) => `${FIGURE}${index}`)
  return [...names, ...figures]
}

/** El ancho y el alto de un PNG, leídos de su cabecera (los bytes 16 a 24), sin decodificarlo. */
export function pngSize(base64: string): { w: number; h: number } | null {
  try {
    const bytes = atob(base64.slice(0, 44))
    if (bytes.length < 24 || !bytes.startsWith('\x89PNG')) return null
    const at = (i: number) =>
      ((bytes.charCodeAt(i) << 24) |
        (bytes.charCodeAt(i + 1) << 16) |
        (bytes.charCodeAt(i + 2) << 8) |
        bytes.charCodeAt(i + 3)) >>>
      0
    return { w: at(16), h: at(20) }
  } catch {
    return null
  }
}

const png = (data: string) => `data:image/png;base64,${data}`

const cell = (value: unknown): string | number | boolean | null =>
  value === null || value === undefined
    ? null
    : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string'
      ? value
      : String(value)

/** El contenido de un visor a partir de lo observado. */
export function contentOf(key: PinKey, view: RunView, assets: Assets | undefined): ViewerContent {
  const isFigure = key.name.startsWith(FIGURE)
  const title = isFigure ? 'figura' : key.name
  if (view.state === 'never') {
    return { title, subtitle: 'sin ejecutar', text: ['Ejecuta el nodo para ver su valor.'] }
  }
  const stale = view.state === 'stale'

  if (isFigure) {
    const figure = assets?.figures[Number(key.name.slice(FIGURE.length))]
    const size = figure ? pngSize(figure.data) : null
    return figure
      ? {
          title,
          stale,
          image: { src: png(figure.data), w: size?.w ?? 400, h: size?.h ?? 300 },
        }
      : { title, stale, text: ['La figura ya no está: vuelve a ejecutar el nodo.'] }
  }

  const summary: Summary | undefined = key.name === '_' ? view.result : view.values?.[key.name]
  if (!summary) return { title, stale, text: ['Este nodo ya no deja este valor.'] }
  const content: ViewerContent = { title, subtitle: describeSummary(summary), stale }
  const text: string[] = []
  if (summary.table) {
    content.table = {
      columns: summary.table.columns,
      rows: summary.table.rows.map((row) => row.map(cell)),
    }
  }
  const thumbnail = assets?.images[key.name]
  if (thumbnail) {
    const size = pngSize(thumbnail)
    content.image = { src: png(thumbnail), w: size?.w ?? 200, h: size?.h ?? 200 }
  }
  if (summary.sample) {
    const more = summary.shape && summary.sample.length < summary.shape.reduce((a, b) => a * b, 1)
    text.push(`${summary.sample.join(', ')}${more ? ', …' : ''}`)
    if (summary.range) text.push(`rango [${summary.range[0]}, ${summary.range[1]}]`)
  }
  if (summary.items) {
    text.push(...summary.items)
    if (summary.length !== undefined && summary.items.length < summary.length) {
      text.push(`… ${summary.length - summary.items.length} más`)
    }
  }
  if (!summary.table && !summary.sample && !summary.items && !content.image && summary.repr) {
    text.push(summary.repr)
  }
  if (text.length > 0) content.text = text
  return content
}

/** Añade un visor si no estaba (uno por valor); si ya estaba, lo quita. */
export function togglePin(pins: readonly PinKey[], key: PinKey): PinKey[] {
  return pins.some((pin) => sameKey(pin, key))
    ? pins.filter((pin) => !sameKey(pin, key))
    : [...pins, key].slice(-MAX_PINS)
}
