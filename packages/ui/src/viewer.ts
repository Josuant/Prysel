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
  /** Alto de la curva de una serie. */
  chart: 84,
}

/** El ancho de un visor: el de su imagen o su tabla, dentro de unos límites. */
export function viewerWidth(content: ViewerContent): number {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
  if (content.table) {
    return clamp(content.table.columns.length * 92 + 2 * VIEWER.pad, VIEWER.minW, VIEWER.tableMaxW)
  }
  if (content.image) return clamp(content.image.w + 2 * VIEWER.pad, VIEWER.minW, VIEWER.maxW)
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
  if (content.text?.length) body += content.text.length * VIEWER.line + 4
  return VIEWER.head + Math.max(body, VIEWER.line) + VIEWER.pad
}

export const viewerSize = (content: ViewerContent): { w: number; h: number } => ({
  w: viewerWidth(content),
  h: viewerHeight(content),
})
