/**
 * Un visor: una ventana en el lienzo que enseña el valor que un nodo dejó al ejecutarse (una tabla, una
 * figura, una imagen, unos pocos elementos). No es código: no escribe nada en el archivo y no cambia lo
 * que el programa hace. Quien lo usa prepara este contenido a partir de lo que observó; aquí solo se
 * sabe dibujarlo y cuánto mide.
 */

export interface ViewerContent {
  /** Lo que se está viendo: el nombre de la variable, o «figura». */
  title: string
  /** Una línea con el tipo y la forma: `ndarray 200×2 float64`. */
  subtitle?: string
  /** El resultado quedó atrás (algo cambió después de ejecutarlo): se atenúa. */
  stale?: boolean
  /** No enseña un valor: dice que la IA está trabajando ahí. Late mientras dura. */
  busy?: boolean
  /**
   * Es el hueco de algo que aún no existe (lo que el usuario está pidiendo): qué clase de cosa va a ser. Se
   * dibuja con su icono y su color, para que se reconozca antes de que haya código.
   */
  ghost?:
    'function' | 'class' | 'loop' | 'condition' | 'value' | 'list' | 'program' | 'change' | 'talk'
  /**
   * Con `ghost`: lo que ya se sabe de la pieza mientras se pide. Su nombre (cuando se ha dicho), lo que
   * recibe, y lo que se lleva dicho de lo que hace. La caja se va rellenando con ello, palabra a palabra.
   */
  draft?: { name?: string; takes?: readonly string[]; does?: string }
  /** Es una ayuda para entender (una curva, una tabla), no algo que el programa haya calculado. */
  aid?: boolean
  table?: {
    columns: { name: string; dtype: string; nulls?: number }[]
    rows: (string | number | boolean | null)[][]
  }
  /** Una imagen `data:` con su tamaño en píxeles (el visor la ajusta a su ancho). */
  image?: { src: string; w: number; h: number }
  /**
   * Una curva: lo que valió un nombre en cada vuelta de un bucle (`at`, la vuelta de cada punto, base 0)
   * sobre `n` vueltas en total. Se dibuja como una línea con su mínimo y su máximo.
   */
  series?: { at: number[]; values: number[]; n: number }
  /** Líneas de texto: una muestra, los elementos de una lista, la representación de un valor. */
  text?: string[]
  /**
   * **Cómo va cambiando** algo: una fila por momento (su rótulo y lo que valía entonces). `lit`: qué letras
   * de esa fila ya son las del final: se encienden, y se ve cómo se va acercando.
   */
  steps?: { label: string; text: string; lit?: boolean[] }[]
  /**
   * Una **lista de números** en varios momentos: una tira de barras por momento (todas a la misma escala).
   * `lit`: las que ya valen lo que al final; se ve cómo la lista se va colocando.
   */
  strips?: { label: string; values: number[]; lit?: boolean[] }[]
  /**
   * Un **tablero** en varios momentos: una rejilla pequeña por momento. `cells`: el tono de cada casilla
   * (`0`, vacía; del `1` en adelante, cada clase de ficha).
   */
  grids?: { label: string; cells: number[][] }[]
}

/** Lo que mide un visor: crece con su contenido hasta un tope, y no más. */
export const VIEWER = {
  minW: 240,
  maxW: 400,
  tableMaxW: 560,
  imageMaxH: 300,
  head: 38,
  pad: 10,
  row: 21,
  headRow: 34,
  line: 17,
  /** Lo que mide una letra de un texto (de ancho fijo), para saber cuándo se parte una línea. */
  char: 6.8,
  /** Alto de la curva de una serie. */
  chart: 84,
  /** Alto de una tira de barras, y lo que se deja entre dos rejillas (y a su rótulo). */
  strip: 24,
  gridGap: 10,
  gridLabel: 14,
}

/**
 * Cómo se reparten las rejillas de un visor: lo que mide cada casilla (para que el tablero se vea, sea de 3×3
 * o de 20×20), lo que ocupa cada rejilla, y cuántas caben por fila en ese ancho.
 */
export function gridLayout(
  grids: NonNullable<ViewerContent['grids']>,
  width: number,
): { cell: number; w: number; h: number; perRow: number; rows: number } {
  const rows = grids[0]?.cells.length ?? 1
  const cols = grids[0]?.cells[0]?.length ?? 1
  const cell = Math.min(14, Math.max(3, Math.floor(104 / Math.max(rows, cols))))
  const w = cols * cell
  const h = rows * cell
  const room = width - 2 * VIEWER.pad
  const perRow = Math.max(1, Math.floor((room + VIEWER.gridGap) / (w + VIEWER.gridGap)))
  return { cell, w, h, perRow, rows: Math.ceil(grids.length / perRow) }
}

/** El ancho de un visor: el de su imagen o su tabla, dentro de unos límites. */
export function viewerWidth(content: ViewerContent): number {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
  if (content.table) {
    return clamp(content.table.columns.length * 92 + 2 * VIEWER.pad, VIEWER.minW, VIEWER.tableMaxW)
  }
  if (content.image) return clamp(content.image.w + 2 * VIEWER.pad, VIEWER.minW, VIEWER.maxW)
  if (content.grids?.length) {
    // Las rejillas, en una fila si caben: tantas como haya, hasta el tope.
    const cols = content.grids[0]?.cells[0]?.length ?? 1
    const rows = content.grids[0]?.cells.length ?? 1
    const cell = Math.min(14, Math.max(3, Math.floor(104 / Math.max(rows, cols))))
    const all = content.grids.length * (cols * cell + VIEWER.gridGap) - VIEWER.gridGap
    return clamp(all + 2 * VIEWER.pad + 2, 320, VIEWER.maxW)
  }
  if (content.strips) return 320
  if (content.steps) {
    // Lo que se lee fila a fila manda en el ancho: una lista corta cabe entera.
    const longest = Math.max(0, ...content.steps.map((step) => step.text.length))
    return clamp(Math.ceil(longest * VIEWER.char) + 2 * VIEWER.pad + 46, 320, VIEWER.maxW)
  }
  if (content.series) return 320
  return 300
}

/** El tamaño de la imagen dentro del visor: a su ancho, sin pasar del alto máximo (y sin ampliarla). */
export function viewerImageSize(
  content: ViewerContent,
  width = viewerWidth(content),
): { w: number; h: number } {
  if (!content.image) return { w: 0, h: 0 }
  const { w, h } = content.image
  const room = width - 2 * VIEWER.pad - 2
  const scale = Math.min(1, room / Math.max(1, w), VIEWER.imageMaxH / Math.max(1, h))
  return { w: Math.round(w * scale), h: Math.round(h * scale) }
}

export function viewerHeight(content: ViewerContent): number {
  let body = 0
  if (content.table) body += VIEWER.headRow + content.table.rows.length * VIEWER.row + 4
  if (content.image) body += viewerImageSize(content).h + 4
  if (content.series) body += VIEWER.chart + 4
  if (content.steps?.length) body += content.steps.length * VIEWER.line + 6
  if (content.strips?.length) body += content.strips.length * VIEWER.strip + 6
  if (content.grids?.length) {
    const layout = gridLayout(content.grids, viewerWidth(content))
    body += layout.rows * (layout.h + VIEWER.gridLabel + 6) + 4
  }
  if (content.text?.length) {
    // Una línea más larga que el visor se parte: cuenta por las filas que ocupa, no por una.
    const perRow = Math.max(8, Math.floor((viewerWidth(content) - 2 * VIEWER.pad) / VIEWER.char))
    const rows = content.text.reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(line.length / perRow)),
      0,
    )
    body += rows * VIEWER.line + 4
  }
  return VIEWER.head + Math.max(body, VIEWER.line) + VIEWER.pad
}

export const viewerSize = (content: ViewerContent): { w: number; h: number } =>
  // La caja de algo que se está pidiendo mide lo que una pieza: su cabecera, lo que recibe (si se ha
  // dicho), lo que se va diciendo de ella y las líneas de su cuerpo.
  content.ghost && content.draft
    ? {
        w: 280,
        h:
          118 +
          ((content.draft.takes?.length ?? 0) > 0 ? 30 : 0) +
          Math.min(3, Math.ceil((content.draft.does?.length ?? 0) / 34)) * 18,
      }
    : { w: viewerWidth(content), h: viewerHeight(content) }
