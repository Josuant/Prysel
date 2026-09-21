/**
 * Una nota: un rótulo a mano en el lienzo que explica lo que tiene al lado (un nodo, un valor). No es
 * código: no escribe nada en el archivo ni cambia lo que el programa hace. Quien la usa prepara este
 * contenido; aquí solo se sabe dibujarla y cuánto mide.
 */

/** Cómo se ve y qué dice cada clase de nota; se distinguen también por la forma, no solo por el color. */
export const NOTE_STYLES = {
  /** Una nota adhesiva: lo que se cuenta de pasada. */
  sticky: 'Nota',
  /** Una llamada con flecha: mira aquí. */
  callout: 'Fíjate',
  /** El error típico: «ojo con esto». */
  warning: 'Ojo',
  /** Qué significa una palabra. */
  definition: 'Definición',
  /** Algo que se entiende mejor por comparación. */
  analogy: 'Analogía',
  /** Un comentario al margen, sin caja. */
  margin: 'Al margen',
} as const

export type NoteStyle = keyof typeof NOTE_STYLES

export const isNoteStyle = (value: unknown): value is NoteStyle =>
  typeof value === 'string' && Object.hasOwn(NOTE_STYLES, value)

export interface NoteContent {
  text: string
  style: NoteStyle
  /** Un título corto en negrita, encima del texto. */
  title?: string
  /** Es la nota del momento que se está explicando: se enseña con toda su fuerza. */
  current?: boolean
  /** Es de un momento que ya pasó: se retira un poco para que no compita con la actual. */
  past?: boolean
  /** Todavía no llegó su momento: no se dibuja, pero conserva su sitio en el margen para que nada se mueva. */
  hidden?: boolean
}

/** Un trozo de texto con su formato: `**negrita**` y `` `código` ``. */
export interface NoteSpan {
  text: string
  kind: 'plain' | 'bold' | 'code'
}

/** Parte un texto en sus trozos. Lo que no cierra (un `**` suelto) se queda como texto. */
export function noteSpans(text: string): NoteSpan[] {
  const spans: NoteSpan[] = []
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index
    if (at > last) spans.push({ text: text.slice(last, at), kind: 'plain' })
    if (match[1] !== undefined) spans.push({ text: match[1], kind: 'bold' })
    else spans.push({ text: match[2] ?? '', kind: 'code' })
    last = at + match[0].length
  }
  if (last < text.length) spans.push({ text: text.slice(last), kind: 'plain' })
  return spans
}

/** El texto tal como se lee, sin marcas. */
export const plainNote = (text: string): string =>
  noteSpans(text)
    .map((span) => span.text)
    .join('')

/** Lo que mide una nota: crece con lo que dice, hasta que deja de caber. */
export const NOTE = {
  width: 232,
  marginWidth: 216,
  pad: 12,
  /** Cuántos caracteres caben en una línea (con margen: la letra a mano no es de ancho fijo). */
  perLine: 19,
  line: 24,
  title: 26,
}

/** Cuántas líneas ocupa un texto al partirlo por palabras. */
export function noteLines(text: string, perLine = NOTE.perLine): number {
  let lines = 0
  for (const paragraph of plainNote(text).split('\n')) {
    let used = 0
    let count = 1
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      // Una palabra más larga que la línea se parte.
      const extra = Math.max(0, Math.ceil(word.length / perLine) - 1)
      if (used > 0 && used + 1 + word.length > perLine) {
        count++
        used = 0
      }
      used += (used > 0 ? 1 : 0) + Math.min(word.length, perLine)
      count += extra
    }
    lines += count
  }
  return Math.max(1, lines)
}

export function noteSize(content: NoteContent): { w: number; h: number } {
  const w = content.style === 'margin' ? NOTE.marginWidth : NOTE.width
  const lines = noteLines(content.text)
  const title = content.title ? NOTE.title : 0
  return { w, h: 2 * NOTE.pad + title + lines * NOTE.line + 4 }
}

/** El margen de las notas: a cuánta distancia del diagrama empiezan. */
export const NOTE_GUTTER = 48

export interface NoteSlot {
  id: string
  /** El rectángulo del nodo al que se refiere: la nota se pone a su altura. */
  anchor: { x: number; y: number; w: number; h: number }
  size: { w: number; h: number }
}

/**
 * Dónde va cada nota: en un margen a la derecha del diagrama, a la altura de lo que explica, como las notas
 * al margen de un libro. Si dos se pisarían, se apartan lo justo **en los dos sentidos** (las que cuelgan del
 * mismo nodo se reparten alrededor de él, en vez de irse todas hacia abajo): la posición que menos se aleja
 * de lo que cada una quería, sin solaparse. No entran en el reparto del diagrama: aparecer o desaparecer una
 * nota nunca mueve nada de lo que ya estaba.
 */
export function placeNotes(
  slots: readonly NoteSlot[],
  x: number,
  spacing = 14,
): Map<string, { x: number; y: number }> {
  // Por la altura del ancla (y por el orden en que llegan, si coinciden): el orden de lectura.
  const ordered = slots
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => a.slot.anchor.y - b.slot.anchor.y || a.index - b.index)
    .map(({ slot }) => slot)
  // Lo que cada una querría (centrada en su ancla) y cuánto se apila por encima de ella.
  const wanted: number[] = []
  const stacked: number[] = []
  let above = 0
  for (const slot of ordered) {
    wanted.push(slot.anchor.y + slot.anchor.h / 2 - slot.size.h / 2)
    stacked.push(above)
    above += slot.size.h + spacing
  }
  // Sin solaparse, el arranque de la pila `z` no baja de una nota a la siguiente: es una regresión
  // isotónica de `wanted - stacked`, que se resuelve juntando en bloques (media) las que se contradicen.
  const blocks: { sum: number; count: number }[] = []
  for (const [i, want] of wanted.entries()) {
    blocks.push({ sum: want - (stacked[i] ?? 0), count: 1 })
    for (;;) {
      const last = blocks[blocks.length - 1]
      const before = blocks[blocks.length - 2]
      if (!last || !before || before.sum / before.count <= last.sum / last.count) break
      blocks.splice(-2, 2, { sum: before.sum + last.sum, count: before.count + last.count })
    }
  }
  const placed = new Map<string, { x: number; y: number }>()
  let at = 0
  for (const block of blocks) {
    const start = block.sum / block.count
    for (let i = at; i < at + block.count; i++) {
      const slot = ordered[i]
      if (slot) placed.set(slot.id, { x, y: start + (stacked[i] ?? 0) })
    }
    at += block.count
  }
  return placed
}
