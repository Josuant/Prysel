/**
 * «Qué hace» una función, dibujado: lo que entró → lo que salió, con los datos de una vez que se ejecutó de
 * verdad. Es la tarjeta de una función plegada: se entiende qué hace sin abrir su diagrama.
 *
 * Una escena son **carriles** que se leen de izquierda a derecha, con una flecha entre cada dos, y en cada
 * carril, **piezas** apiladas (un dato, la consola, un objeto antes y después…). Quien la usa prepara la
 * escena a partir de lo que observó; aquí solo se sabe cuánto mide y cómo se dibuja. Las piezas son pocas a
 * propósito: con las mismas se podrán componer otras escenas (una regla, una repetición).
 */

/** Un valor con su forma: una rejilla se dibuja como rejilla, no como texto. */
export type GistValue =
  | { kind: 'atom'; type: 'number' | 'text' | 'bool' | 'none'; text: string }
  | { kind: 'list'; shape: 'list' | 'tuple' | 'set'; items: GistValue[]; more: boolean }
  | { kind: 'dict'; entries: [GistValue, GistValue][]; more: boolean }
  | { kind: 'opaque'; text: string }

export type GistPiece =
  /** Un dato con su nombre. `changed`: es como quedó algo que entró de otra manera. */
  | { type: 'datum'; label?: string; value: GistValue; changed?: boolean }
  /** Lo que se imprimió. */
  | { type: 'console'; text: string }
  /** Un objeto: sus campos, y cómo quedaron los que cambiaron. */
  | {
      type: 'state'
      cls: string
      rows: { name: string; before?: GistValue; after: GistValue; changed: boolean }[]
    }
  | { type: 'error'; text: string }
  /** Una frase suelta: «no recibe nada», o por qué no hay muestra. */
  | { type: 'note'; text: string }

export interface GistScene {
  /** El nombre de la función. */
  name: string
  /** Lo que hace, en una frase. */
  title?: string
  /** La entrada no estaba en el programa: se propuso para probar. */
  example?: boolean
  /** El código cambió después: se está volviendo a comprobar. */
  stale?: boolean
  lanes: GistPiece[][]
}

/** Lo que mide cada cosa: el dibujo usa estas mismas medidas, así el lienzo reserva el sitio justo. */
export const GIST = {
  pad: 12,
  head: 26,
  sub: 18,
  gap: 8,
  arrow: 30,
  label: 15,
  cell: 24,
  cellGap: 2,
  char: 7.3,
  line: 17,
  row: 22,
  maxCells: 8,
  maxRows: 6,
  maxLines: 6,
  maxFields: 5,
  maxText: 30,
  minW: 220,
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`

/** El valor, como texto de Python. */
export function gistText(value: GistValue): string {
  if (value.kind === 'atom' || value.kind === 'opaque') return value.text
  const rest = value.more ? ['…'] : []
  if (value.kind === 'dict') {
    const entries = value.entries.map(([key, item]) => `${gistText(key)}: ${gistText(item)}`)
    return `{${[...entries, ...rest].join(', ')}}`
  }
  const items = [...value.items.map(gistText), ...rest].join(', ')
  if (value.shape === 'list') return `[${items}]`
  if (value.shape === 'set') return `{${items}}`
  return value.items.length === 1 && !value.more ? `(${items},)` : `(${items})`
}

/** Las filas de una rejilla: una lista de listas del mismo largo, de valores sueltos. */
export function gistMatrix(value: GistValue): string[][] | null {
  if (value.kind !== 'list' || value.shape === 'set' || value.items.length === 0) return null
  const rows: string[][] = []
  for (const row of value.items) {
    if (row.kind !== 'list' || row.shape === 'set' || row.more || row.items.length === 0)
      return null
    if (row.items.some((cell) => cell.kind !== 'atom')) return null
    rows.push(row.items.map(gistText))
  }
  return rows.every((row) => row.length === rows[0]?.length) ? rows : null
}

/** Cómo se dibuja un valor: una rejilla, una fila de celdas, unas filas de clave y valor, o un texto. */
export type GistShape =
  | { as: 'grid'; rows: string[][]; cellW: number; moreRows: number; moreCols: number }
  | { as: 'cells'; cells: string[]; widths: number[]; more: boolean }
  | { as: 'pairs'; rows: string[]; more: boolean }
  | { as: 'text'; text: string }

const cellWidth = (text: string) => Math.max(GIST.cell, Math.ceil(text.length * GIST.char) + 10)

export function gistShape(value: GistValue): GistShape {
  const matrix = gistMatrix(value)
  if (matrix) {
    const rows = matrix
      .slice(0, GIST.maxRows)
      .map((row) => row.slice(0, GIST.maxCells).map((cell) => clip(cell, 6)))
    return {
      as: 'grid',
      rows,
      cellW: Math.max(...rows.flat().map(cellWidth)),
      moreRows: Math.max(0, matrix.length - GIST.maxRows),
      moreCols: Math.max(0, (matrix[0]?.length ?? 0) - GIST.maxCells),
    }
  }
  if (
    value.kind === 'list' &&
    value.items.length > 0 &&
    value.items.every((item) => item.kind === 'atom')
  ) {
    const cells = value.items.slice(0, GIST.maxCells).map((item) => clip(gistText(item), 12))
    return {
      as: 'cells',
      cells,
      widths: cells.map(cellWidth),
      more: value.more || value.items.length > GIST.maxCells,
    }
  }
  if (value.kind === 'dict' && value.entries.length > 0) {
    return {
      as: 'pairs',
      rows: value.entries
        .slice(0, GIST.maxFields)
        .map(([key, item]) => clip(`${gistText(key)}: ${gistText(item)}`, GIST.maxText)),
      more: value.more || value.entries.length > GIST.maxFields,
    }
  }
  return { as: 'text', text: clip(gistText(value), GIST.maxText) }
}

const textWidth = (text: string) => Math.ceil(text.length * GIST.char) + 16

function shapeSize(shape: GistShape): { w: number; h: number } {
  if (shape.as === 'grid') {
    const cols = (shape.rows[0]?.length ?? 0) + (shape.moreCols > 0 ? 1 : 0)
    const rows = shape.rows.length + (shape.moreRows > 0 ? 1 : 0)
    return {
      w: cols * shape.cellW + (cols - 1) * GIST.cellGap,
      h: rows * GIST.cell + (rows - 1) * GIST.cellGap,
    }
  }
  if (shape.as === 'cells') {
    const widths = [...shape.widths, ...(shape.more ? [GIST.cell] : [])]
    return {
      w: widths.reduce((sum, w) => sum + w, 0) + (widths.length - 1) * GIST.cellGap,
      h: GIST.cell,
    }
  }
  if (shape.as === 'pairs') {
    const rows = [...shape.rows, ...(shape.more ? ['…'] : [])]
    return { w: Math.max(...rows.map(textWidth)), h: rows.length * GIST.row }
  }
  return { w: textWidth(shape.text), h: GIST.cell }
}

/** Las líneas de la consola que se enseñan, y cuántas quedan fuera. */
export function gistConsole(text: string): { lines: string[]; more: number } {
  const all = text.replace(/\n$/, '').split('\n')
  return {
    lines: all.slice(0, GIST.maxLines).map((line) => clip(line, 34)),
    more: Math.max(0, all.length - GIST.maxLines),
  }
}

/** Las filas de un objeto que se enseñan: `nombre  antes → después`, o `nombre  valor` si no cambió. */
export function gistStateRows(piece: Extract<GistPiece, { type: 'state' }>) {
  // Lo que cambió va primero: es lo que el método hizo.
  const ordered = [...piece.rows].sort((a, b) => Number(b.changed) - Number(a.changed))
  return {
    rows: ordered.slice(0, GIST.maxFields).map((row) => ({
      name: row.name,
      before: row.changed && row.before !== undefined ? clip(gistText(row.before), 16) : undefined,
      after: clip(gistText(row.after), 18),
      changed: row.changed,
    })),
    more: Math.max(0, ordered.length - GIST.maxFields),
  }
}

export function gistPieceSize(piece: GistPiece): { w: number; h: number } {
  if (piece.type === 'datum') {
    const box = shapeSize(gistShape(piece.value))
    const label = piece.label ? Math.ceil(piece.label.length * 6.4) : 0
    return { w: Math.max(box.w, label), h: (piece.label ? GIST.label : 0) + box.h }
  }
  if (piece.type === 'console') {
    const { lines, more } = gistConsole(piece.text)
    const shown = [...lines, ...(more > 0 ? [`… ${more} más`] : [])]
    return {
      w: Math.max(96, ...shown.map((line) => Math.ceil(line.length * GIST.char) + 20)),
      h: GIST.label + 12 + shown.length * GIST.line,
    }
  }
  if (piece.type === 'state') {
    const { rows, more } = gistStateRows(piece)
    const widths = rows.map(
      (row) =>
        Math.ceil(
          (row.name.length + (row.before ? row.before.length + 3 : 0) + row.after.length + 2) *
            GIST.char,
        ) + 20,
    )
    return {
      w: Math.max(96, Math.ceil(piece.cls.length * 6.4), ...widths),
      h: GIST.label + (rows.length + (more > 0 ? 1 : 0)) * GIST.row,
    }
  }
  if (piece.type === 'error')
    return { w: textWidth(clip(piece.text, 40)), h: GIST.label + GIST.cell }
  return { w: Math.ceil(clip(piece.text, 44).length * 6.6) + 4, h: GIST.cell }
}

const laneSize = (lane: readonly GistPiece[]): { w: number; h: number } => {
  const sizes = lane.map(gistPieceSize)
  return {
    w: Math.max(0, ...sizes.map((size) => size.w)),
    h: sizes.reduce((sum, size) => sum + size.h, 0) + Math.max(0, sizes.length - 1) * GIST.gap,
  }
}

/** Lo que mide la tarjeta entera. */
export function gistSize(scene: GistScene): { w: number; h: number } {
  const lanes = scene.lanes.map(laneSize)
  const body = lanes.reduce((sum, lane) => sum + lane.w, 0) + (lanes.length - 1) * GIST.arrow
  // La cabecera: el icono, el nombre, la marca «ejemplo» y el botón de abrir.
  const head = 30 + Math.ceil(scene.name.length * 8) + (scene.example ? 66 : 0) + 34
  const sub = scene.title ? Math.min(52, scene.title.length) * 6.4 : 0
  // Dos píxeles de holgura: el ancho de una letra no es exacto.
  const w = GIST.pad * 2 + Math.max(GIST.minW - GIST.pad * 2, body + 2, head, sub)
  const h =
    GIST.pad * 2 +
    GIST.head +
    (scene.title ? GIST.sub : 0) +
    GIST.gap +
    Math.max(GIST.cell, ...lanes.map((lane) => lane.h))
  return { w: Math.round(w / 2) * 2, h: Math.round(h / 2) * 2 }
}
