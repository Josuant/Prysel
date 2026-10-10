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
  /**
   * Un dato con su nombre. `changed`: es como quedó algo que entró de otra manera. Con recorrido: `beats`
   * dice en qué paso le toca a cada elemento (en orden de lectura; `null`: no participa); `arrives`, que
   * no está hasta que le toca (es un resultado); `fades`, qué elementos se quedan fuera tras su paso.
   */
  | {
      type: 'datum'
      label?: string
      value: GistValue
      changed?: boolean
      /** No lo recibe: lo lee del programa (un objetivo, un tamaño). Se marca en su nombre. */
      hidden?: boolean
      beats?: readonly (number | null)[]
      arrives?: boolean
      fades?: readonly boolean[]
    }
  /** Lo que se imprimió. `beats`: cada carácter (sin contar los saltos) aparece en el paso de su número. */
  | { type: 'console'; text: string; beats?: boolean }
  /** Un objeto: sus campos, y cómo quedaron los que cambiaron. */
  | {
      type: 'state'
      cls: string
      rows: { name: string; before?: GistValue; after: GistValue; changed: boolean }[]
    }
  /** Una regla por casos: con qué valor, qué da (`1 → *`, `otro → .`). */
  /** `via`: en cada paso del recorrido, qué caso se aplica. */
  | {
      type: 'rule'
      label: string
      cases: { when: string; gives: string }[]
      via?: readonly number[]
    }
  /** Una condición que cada elemento pasa o no (`n % 2 == 0`). `verdicts`: qué sale en cada paso. */
  | { type: 'test'; label: string; text: string; verdicts?: readonly boolean[] }
  /** Una cuenta que se va llevando (una suma, un máximo). `running`: lo que lleva tras cada paso. */
  | { type: 'fold'; label: string; symbol: string; running?: readonly string[] }
  | { type: 'error'; text: string }
  /**
   * Las vueltas de un bucle, como una tabla que se va llenando: una fila por vuelta con lo que tomó (las
   * columnas de la cabecera) y cómo quedaron las variables que lleva (`changed`: cambió en esa vuelta).
   * `start` son los valores al entrar (vacío en las columnas de la cabecera). Con recorrido, la vuelta `k`
   * aparece en el paso `k`. `skipped`: cuántas vueltas no se enseñan y antes de qué fila.
   */
  | {
      type: 'laps'
      label: string
      columns: string[]
      /** Cuántas de las columnas son lo que toma la cabecera (las demás, lo que lleva el bucle). */
      takes: number
      /** Lo que encabeza la columna del número de fila (`#` si no). */
      counter?: string
      start?: LapCell[]
      rows: { cells: LapCell[]; changed: boolean[]; exit?: 'break' | 'continue' }[]
      skipped?: { count: number; at: number }
      end: string
    }
  /**
   * Un `try`, como una red de seguridad: una fila por parte (lo que se intenta y cada cláusula), con lo que
   * pasó en cada una. `fall`: el error que salta en la fila del intento y cae hasta la fila del `except` que
   * lo atrapa (`to`: su índice; `null`, nadie lo atrapa y se escapa). Con recorrido, la fila `k` llega en el
   * paso `k`.
   */
  | {
      type: 'net'
      label: string
      rows: NetRow[]
      fall?: { error: string; to: number | null }
      end: string
    }
  /**
   * Un `if` como unas agujas de tren: una fila por brazo (el `if`, cada `elif`, el `else`). En cada visita (un
   * paso del recorrido), las condiciones con los valores de ese momento, lo que dieron, y una bola que cae
   * hasta el brazo por el que siguió (`arm` −1: por ninguno, de largo). Cada brazo cuenta sus visitas.
   * `totals`/`none`: el recuento de todas las veces, también las que no se cuentan una a una.
   */
  | {
      type: 'switch'
      label: string
      arms: { part: string; head: string }[]
      visits: { arm: number; tests: (string | null)[]; verdicts: (boolean | null)[] }[]
      totals: number[]
      none: number
      end: string
    }
  /**
   * Unas **tiras**: filas de celdas alineadas, cada celda con su tono. Es con lo que se enseña un mecanismo:
   * de qué padre viene cada letra del hijo, qué posiciones coinciden con el objetivo, quién sube al podio,
   * cómo se va llenando una lista. `gauge`: una medida al pie, cuánto de cuánto.
   */
  | {
      type: 'strips'
      label: string
      strips: GistStrip[]
      gauge?: { value: number; of: number; says: string }
      foot?: string
    }
  /** Una frase suelta: «no recibe nada», o por qué no hay muestra. */
  | { type: 'note'; text: string }

/**
 * El tono de una celda de una tira: viene de la primera entrada (`a`), de la segunda (`b`), de cualquiera de
 * las dos (`both`), coincide (`hit`), no coincide (`miss`), o es nueva (`new`: no viene de ninguna, o acaba de
 * entrar).
 */
export type StripTone = 'a' | 'b' | 'both' | 'hit' | 'miss' | 'new'

export interface GistStrip {
  /** Cómo se llama la fila (una entrada, «devuelve», el número de un paso). */
  name: string
  /** No lo recibe: lo lee del programa. */
  hidden?: boolean
  /** En un podio: su puesto (`0`: se quedó fuera). */
  place?: number
  cells: { text: string; tone?: StripTone }[]
  /** Cuántas celdas no se enseñan. */
  more?: number
  /** Lo que se dice a su derecha (su nota, lo que acaba de entrar). */
  note?: string
}

export interface GistScene {
  /** El nombre de la función (o la cabecera del bloque). */
  name: string
  /** Qué bloque cuenta: una función (por defecto), un bucle, un `try` o una clase. Cambia el icono y el nombre. */
  block?: 'function' | 'loop' | 'try' | 'class' | 'condition'
  /** Lo que hace, en una frase. */
  title?: string
  /** El código de su cabecera, cuando el nombre se dice con palabras: se enseña al pasar el puntero. */
  code?: string
  /** La entrada no estaba en el programa: se propuso para probar. */
  example?: boolean
  /** La entrada la puso quien lo usa, para probarla con sus datos. */
  mine?: boolean
  /** El programa nunca la llama: lo que se enseña es una prueba aparte. */
  unused?: boolean
  /** Se puede probar con otros datos: la tarjeta ofrece cambiarlos. */
  editable?: boolean
  /** El código cambió después: se está volviendo a comprobar. */
  stale?: boolean
  /** Cuántos pasos tiene el recorrido (elemento a elemento); sin ellos, la escena no se recorre. */
  beats?: number
  /** Lo que dura cada paso, si no el de serie: una vuelta de un bucle se cuenta más despacio que una celda. */
  stepMs?: number
  lanes: GistPiece[][]
}

/**
 * La escena de un bloque (un bucle, una decisión, un intento) con el nombre que le da el propio programa: el
 * de su etapa, o el comentario que lleva encima. Quien construye hablando dijo «repetir hasta acertar», no
 * `while intento != secreto`: ese es el nombre que reconoce. El código de la cabecera queda a un gesto.
 */
export function titledScene(scene: GistScene, named: { stage?: string; note?: string }): GistScene {
  if (!scene.block || scene.block === 'function' || scene.block === 'class') return scene
  const said = (named.stage ?? named.note?.split('\n')[0] ?? '').replace(/:\s.*$/, '').trim()
  if (said === '' || said.length > 60) return scene
  return { ...scene, name: said, code: scene.code ?? scene.name }
}

/**
 * Una escena dicha en una línea: lo primero que entró → lo último que salió (`25 12 8 40 → 85`). Es lo que
 * enseña el rótulo de una etapa plegada de lo que guarda dentro, para leer el programa como un mapa.
 */
export function gistPeek(scene: GistScene): string {
  const say = (piece: GistPiece | undefined): string => {
    if (!piece) return ''
    if (piece.type === 'datum') return clip(gistText(piece.value), 22)
    if (piece.type === 'console') return clip(piece.text.split('\n')[0] ?? '', 22)
    if (piece.type === 'error') return 'falla'
    if (piece.type === 'note') return ''
    return ''
  }
  const first = say(scene.lanes[0]?.[0])
  const last = scene.lanes.length > 1 ? say(scene.lanes.at(-1)?.[0]) : ''
  return [first, last].filter((part) => part !== '').join(' → ')
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
  maxCells: 10,
  maxRows: 8,
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
  | {
      as: 'grid'
      rows: string[][]
      /** Cuántas columnas tiene de verdad (las que se enseñan pueden ser menos). */
      cols: number
      cellW: number
      moreRows: number
      moreCols: number
    }
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
      cols: matrix[0]?.length ?? 0,
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

/**
 * Las líneas de la consola que se enseñan, y cuántas quedan fuera. `offsets`: cuántos caracteres hay antes
 * de cada línea (sin contar los saltos), para saber en qué paso del recorrido aparece cada uno.
 */
export function gistConsole(text: string): { lines: string[]; more: number; offsets: number[] } {
  const all = text.replace(/\n$/, '').split('\n')
  const offsets: number[] = []
  let before = 0
  for (const line of all.slice(0, GIST.maxLines)) {
    offsets.push(before)
    before += line.length
  }
  return {
    lines: all.slice(0, GIST.maxLines).map((line) => clip(line, 34)),
    more: Math.max(0, all.length - GIST.maxLines),
    offsets,
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

/** Los casos de una regla que se enseñan, recortados. */
export function gistCases(piece: Extract<GistPiece, { type: 'rule' }>) {
  return piece.cases
    .slice(0, GIST.maxFields + 1)
    .map((entry) => ({ when: clip(entry.when, 44), gives: clip(entry.gives, 12) }))
}

/**
 * Una celda de la tabla de vueltas: un texto, o una lista corta dibujada como celdas, con las posiciones que
 * cambiaron respecto de la vuelta anterior (así se ve un intercambio de una ordenación).
 */
export type LapCell = string | { items: string[]; changed: boolean[] }

/**
 * Una parte de un `try`: `ran`, se ejecutó entera; `raised`, saltó un error dentro; `caught`, este `except`
 * lo atrapó; `skipped`, no se ejecutó. `detail`: la línea que falló, lo que imprimió o dejó cambiado.
 */
export interface NetRow {
  part: 'try' | 'except' | 'else' | 'finally'
  head: string
  state: 'ran' | 'raised' | 'caught' | 'skipped'
  detail?: string
}

/** Lo que mide la columna del nombre de cada parte de un `try`, y lo que se enseña de su cabecera y su detalle. */
export const NET_PART_W = 58
export const netHead = (text: string) => clip(text, 30)
export const netDetail = (text: string) => clip(text.replace(/\n+$/, '').replace(/\n/g, ' · '), 40)
/** El error que cae, corto: su tipo y el principio del mensaje. */
export const netError = (text: string) => clip(text.replace(/\s+/g, ' ').trim(), 28)
export const netErrorWidth = (text: string) => Math.ceil(netError(text).length * 6.4) + 18
/** Lo que mide cada fila de un `if`: la cabecera y, debajo, la condición con sus valores. */
export const SWITCH_ROW = 40
/** El ancho de la columna del nombre de cada brazo y de su contador. */
export const SWITCH_PART_W = 64
export const SWITCH_COUNT_W = 36
export const switchText = (text: string) => clip(text, 34)

/** Lo que mide cada fila de un `try`: su cabecera y, si lo tiene, su detalle debajo. */
export const netRowHeight = (row: NetRow) => GIST.row + (row.detail ? GIST.line : 0) + 4

/** Lo que se enseña de una celda de la tabla de vueltas: corto, que la fila quepa. */
export const lapText = (text: string) => clip(text.replace(/\n/g, ' ').trim(), 14)

/** Lo que mide cada elemento de una lista dentro de la tabla de vueltas. */
export const lapItemWidth = (text: string) =>
  Math.max(16, Math.ceil(clip(text, 6).length * GIST.char) + 8)

const lapCellWidth = (cell: LapCell): number =>
  typeof cell === 'string'
    ? Math.ceil(lapText(cell).length * GIST.char) + 14
    : cell.items.reduce((sum, item) => sum + lapItemWidth(item) + 1, 3)

/** El ancho de cada columna de la tabla de vueltas: la del número de vuelta y las de los datos. */
export function gistLapColumns(piece: Extract<GistPiece, { type: 'laps' }>): number[] {
  const cells = (at: number): LapCell[] => [
    piece.columns[at] ?? '',
    piece.start?.[at] ?? '',
    ...piece.rows.map((row) => row.cells[at] ?? ''),
  ]
  // La primera columna: el número de vuelta (y «antes», si está esa fila).
  return [
    piece.start ? 42 : GIST.cell + 10,
    ...piece.columns.map((_, at) => Math.max(GIST.cell, ...cells(at).map(lapCellWidth))),
  ]
}

/** Las medidas de unas tiras: cuántas celdas se enseñan por fila y lo que se lee de cada cosa. */
export const STRIP = { maxCells: 14, row: GIST.cell + 3, place: 20, gauge: 20 }
export const stripName = (text: string) => clip(text, 14)
export const stripCell = (text: string) => clip(text, 12)
export const stripNote = (text: string) => clip(text, 16)

/** Cómo se colocan unas tiras: lo que mide la columna de los nombres, cada celda (todas igual: van alineadas) y la de las notas. */
export function gistStrips(piece: Extract<GistPiece, { type: 'strips' }>) {
  const strips = piece.strips.map((strip) => ({
    ...strip,
    cells: strip.cells.slice(0, STRIP.maxCells),
    more: (strip.more ?? 0) + Math.max(0, strip.cells.length - STRIP.maxCells),
  }))
  const longest = Math.max(
    0,
    ...strips.flatMap((strip) => strip.cells.map((c) => stripCell(c.text).length)),
  )
  const cellW = Math.max(GIST.cell - 2, Math.ceil(longest * GIST.char) + 8)
  const nameW =
    Math.max(0, ...strips.map((strip) => Math.ceil(stripName(strip.name).length * 6.4))) + 8
  const placed = strips.some((strip) => strip.place !== undefined)
  const noteW = Math.max(
    0,
    ...strips.map((strip) => (strip.note ? Math.ceil(stripNote(strip.note).length * 6.6) + 10 : 0)),
  )
  const cells = Math.max(0, ...strips.map((strip) => strip.cells.length + (strip.more > 0 ? 1 : 0)))
  return { strips, cellW, nameW, placed, noteW, cells }
}

export function gistPieceSize(piece: GistPiece): { w: number; h: number } {
  if (piece.type === 'strips') {
    const { strips, cellW, nameW, placed, noteW, cells } = gistStrips(piece)
    return {
      w: Math.max(
        Math.ceil(piece.label.length * 6.4),
        nameW + (placed ? STRIP.place : 0) + cells * (cellW + GIST.cellGap) + noteW,
        piece.foot ? Math.ceil(clip(piece.foot, 48).length * 6.6) + 4 : 0,
        piece.gauge ? 120 + Math.ceil(piece.gauge.says.length * 6.6) : 0,
      ),
      h:
        GIST.label +
        strips.length * STRIP.row +
        (piece.gauge ? STRIP.gauge : 0) +
        (piece.foot ? GIST.row : 0),
    }
  }
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
  if (piece.type === 'rule') {
    const cases = gistCases(piece)
    return {
      w: Math.max(
        Math.ceil(piece.label.length * 6.4),
        ...cases.map((entry) => cellWidth(entry.when) + 22 + cellWidth(entry.gives)),
      ),
      h: GIST.label + cases.length * GIST.cell + (cases.length - 1) * GIST.cellGap * 2,
    }
  }
  if (piece.type === 'test')
    return {
      w: Math.max(Math.ceil(piece.label.length * 6.4), textWidth(clip(piece.text, 22)) + 22),
      h: GIST.label + GIST.cell,
    }
  if (piece.type === 'fold') {
    const longest = Math.max(1, ...(piece.running ?? []).map((value) => value.length))
    return {
      w: Math.max(Math.ceil(piece.label.length * 6.4), 30 + Math.ceil(longest * GIST.char) + 14),
      h: GIST.label + GIST.cell,
    }
  }
  if (piece.type === 'error')
    return { w: textWidth(clip(piece.text, 40)), h: GIST.label + GIST.cell }
  if (piece.type === 'laps') {
    const widths = gistLapColumns(piece)
    const rows = 1 + (piece.start ? 1 : 0) + piece.rows.length + (piece.skipped ? 1 : 0) + 1
    return {
      w: Math.max(
        Math.ceil(piece.label.length * 6.4),
        widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * GIST.cellGap,
        Math.ceil(clip(piece.end, 44).length * 6.6) + 4,
      ),
      h: GIST.label + rows * GIST.row,
    }
  }
  if (piece.type === 'switch') {
    const widest = Math.max(
      ...piece.arms.map((arm) => switchText(arm.head).length),
      ...piece.visits.flatMap((visit) =>
        visit.tests.map((test) => switchText(test ?? '').length + 4),
      ),
    )
    return {
      w: Math.max(
        Math.ceil(piece.label.length * 6.4),
        SWITCH_PART_W + Math.ceil(widest * GIST.char) + 44 + SWITCH_COUNT_W,
        Math.ceil(clip(piece.end, 60).length * 6.6) + 4,
      ),
      h:
        GIST.label +
        piece.arms.length * SWITCH_ROW +
        (piece.visits.some((v) => v.arm < 0) ? SWITCH_ROW / 2 : 0) +
        GIST.row,
    }
  }
  if (piece.type === 'net') {
    const chip = piece.fall ? netErrorWidth(piece.fall.error) + 8 : 0
    const rows = piece.rows.map((row) =>
      Math.max(
        NET_PART_W + Math.ceil(netHead(row.head).length * GIST.char) + 104 + chip,
        row.detail ? NET_PART_W + Math.ceil(netDetail(row.detail).length * 6.6) + 8 : 0,
      ),
    )
    return {
      w: Math.max(
        Math.ceil(piece.label.length * 6.4),
        ...rows,
        Math.ceil(clip(piece.end, 52).length * 6.6) + 4,
      ),
      h:
        GIST.label +
        piece.rows.reduce((sum, row) => sum + netRowHeight(row), 0) +
        GIST.row * (piece.fall && piece.fall.to === null ? 2 : 1),
    }
  }
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
  const head =
    30 +
    Math.ceil(scene.name.length * 8) +
    (scene.mine ? 80 : scene.unused ? 72 : scene.example ? 66 : 0) +
    (scene.editable ? 28 : 0) +
    34
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
