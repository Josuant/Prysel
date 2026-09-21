import type { ControlModel } from './controls.ts'
import type { Density, Metrics, NodeKindSpec, ScaleBy, ShapeId } from './types.ts'

/**
 * Tamaño base por densidad (w × h), en píxeles del lienzo.
 * `compact` es una píldora: icono, nombre y punto de estado — la referencia rápida de la lógica.
 * `normal` cabe insignia + título + código + pie, con el control editable resumido.
 * `expanded` da sitio al control editable completo.
 */
export const DENSITY_BASE: Record<Density, readonly [number, number]> = {
  compact: [200, 36],
  normal: [258, 156],
  expanded: [300, 248],
}

/**
 * Cuánto puede desviarse un tipo del tamaño base de su densidad. El suelo garantiza que
 * la insignia, el título y el control siempre quepan: la variedad nunca rompe la legibilidad.
 */
const FOOTPRINT_RANGE = [0.92, 1.6] as const
/** En expandido la variación de tipo se amortigua: todos necesitan sitio para su editor. */
const EXPANDED_DAMPING = { w: 0.6, h: 0.35 }

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const snap = (v: number) => Math.round(v / 2) * 2

/**
 * El tamaño mide complejidad, no importancia (presupuesto de complejidad del DS):
 * crece de forma logarítmica y se satura, para que un algoritmo enorme no devore el lienzo.
 */
export function complexityScale(scaleBy: ScaleBy, metrics: Metrics = {}): number {
  switch (scaleBy) {
    case 'ops':
      return clamp(1 + 0.055 * Math.log2(1 + (metrics.ops ?? 0)), 1, 1.28)
    case 'cardinality':
      return clamp(1 + 0.07 * Math.log10(1 + (metrics.cardinality ?? 0)), 1, 1.22)
    case 'none':
      return 1
  }
}

/**
 * En compacto todo nodo es una píldora de la misma altura: una fila de etiquetas que se lee
 * de un vistazo. El recorte dice si transforma o si corta el flujo; el resto lo dicen icono y color.
 */
export function compactShape(kind: Pick<NodeKindSpec, 'id' | 'role'>): ShapeId {
  if (kind.role === 'transform') return 'pill-chevron'
  if (kind.id === 'control.raise') return 'pill-cut'
  return 'pill'
}

/** Al expandirse, una píldora se convierte en tarjeta: necesita sitio para su editor. */
const PILL_TO_CARD: Partial<Record<ShapeId, ShapeId>> = {
  pill: 'card',
  'pill-chevron': 'card-chevron',
  'pill-cut': 'card-cut',
}

export function shapeFor(kind: NodeKindSpec, density: Density): ShapeId {
  if (density === 'compact') return compactShape(kind)
  if (density === 'expanded') return PILL_TO_CARD[kind.shape] ?? kind.shape
  return kind.shape
}

export function nodeSize(
  kind: Pick<NodeKindSpec, 'footprint' | 'scaleBy'>,
  density: Density,
  metrics?: Metrics,
): { w: number; h: number } {
  const [baseW, baseH] = DENSITY_BASE[density]
  const scale = complexityScale(kind.scaleBy, metrics)
  const fw = clamp(kind.footprint.w, ...FOOTPRINT_RANGE)
  const fh = clamp(kind.footprint.h, ...FOOTPRINT_RANGE)

  if (density === 'compact') {
    // Misma altura para todos: una fila de píldoras alineadas.
    return { w: snap(baseW * clamp(fw, 0.9, 1.12) * Math.min(scale, 1.1)), h: baseH }
  }
  if (density === 'expanded') {
    const damp = (f: number, k: number) => 1 + (f - 1) * k
    return {
      w: snap(baseW * damp(fw, EXPANDED_DAMPING.w) * damp(scale, EXPANDED_DAMPING.w)),
      h: snap(baseH * damp(fh, EXPANDED_DAMPING.h) * damp(scale, EXPANDED_DAMPING.h)),
    }
  }
  // La complejidad ensancha el nodo mucho más de lo que lo alarga: el alto lo manda el contenido.
  return { w: snap(baseW * fw * scale), h: snap(baseH * fh * (1 + (scale - 1) * 0.45)) }
}

/**
 * Cuánto necesita de alto el editor de un nodo, en píxeles.
 *
 * El tamaño base de cada densidad da sitio a un editor de una fila. Un editor con varios campos
 * (una llamada con dos argumentos, una condición) no cabe ahí, y si el nodo no crece se
 * recorta: el campo queda oculto y su puerto cae fuera de la tarjeta. Por eso el alto lo
 * decide el contenido, y el layout lo sabe **antes** de pintar.
 */
// Medidas reales del DOM (a zoom 1): un campo, su etiqueta, la línea de destino y el hueco entre filas.
/**
 * Una llamada con hasta este número de argumentos los enseña todos, también en normal: cada uno es un
 * puerto al que se puede conectar un cable, y uno escondido no se puede cablear.
 */
export const INLINE_ARGS = 4

const ROW = { input: 30, labeled: 49, note: 18, gap: 6, label: 19, add: 24 }

/**
 * Cuántas líneas ocupa un texto de `width` caracteres de ancho: el ajuste es por palabras, como
 * el del navegador, no por número de caracteres. Contar caracteres se queda corto en cuanto una
 * palabra larga no cabe donde termina la línea, y una línea de menos es un campo recortado.
 */
function wrappedLines(text: string, width: number): number {
  let total = 0
  for (const paragraph of text.split('\n')) {
    let used = 0
    let lines = 1
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const need = (used === 0 ? 0 : 1) + word.length
      if (used + need <= width) {
        used += need
        continue
      }
      // No cabe: la palabra pasa a la línea siguiente, y si ni sola cabe, se parte en trozos.
      if (used > 0) lines++
      let rest = word.length
      while (rest > width) {
        lines++
        rest -= width
      }
      used = rest
    }
    total += lines
  }
  return total
}

/**
 * Un mensaje de varias líneas crece con su texto, hasta un tope (después, se desplaza).
 * Se estima cuántas líneas ocupa: unos 28 caracteres por línea en normal y 34 en expandido.
 */
const AREA = { line: 17.6, chrome: 12, minLines: 2, maxLines: 5 }
const CHARS_PER_LINE = { normal: 28, expanded: 34 }

function areaHeight(text: string, density: 'normal' | 'expanded'): number {
  const wrapped = wrappedLines(text, CHARS_PER_LINE[density])
  const lines = Math.min(AREA.maxLines, Math.max(AREA.minLines, wrapped))
  return Math.ceil(lines * AREA.line + AREA.chrome)
}

/** Lo que el tamaño base de cada densidad ya acoge sin crecer (medido: alto de tarjeta − marco). */
const ROOM: Record<Density, number> = { compact: 0, normal: 48, expanded: 140 }

/** Apila filas: cada una con su alto y 6 px de hueco entre ellas. */
const stack = (rows: number[]) =>
  rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row, 0) + ROW.gap * (rows.length - 1)

export function controlHeight(
  model: ControlModel | undefined,
  density: Density,
  linked: readonly string[] = [],
): number {
  if (!model || density === 'compact') return 0
  const full = density === 'expanded'
  switch (model.kind) {
    case 'text':
      // En expandido el campo lleva su etiqueta («Valor»).
      return (
        (model.multiline ? areaHeight(model.value, full ? 'expanded' : 'normal') : ROW.input) +
        (full ? ROW.label : 0)
      )
    case 'args': {
      // Un argumento conectado nunca se esconde, y con más de uno cada campo lleva su nombre.
      const isLinked = (name: string) => linked.includes(`arg:${name}`)
      const shown = model.args.filter(
        (a, i) => full || i === 0 || isLinked(a.name) || model.args.length <= INLINE_ARGS,
      )
      const labeled = full || model.args.length > 1 || shown.some((a) => isLinked(a.name))
      const hidden = model.args.length - shown.length
      return stack([
        ...(model.target ? [ROW.note] : []),
        ...shown.map(() => (labeled ? ROW.labeled : ROW.input)),
        ...(hidden > 0 ? [ROW.note] : []),
      ])
    }
    case 'condition':
      return stack([ROW.input, ROW.input, ...(full && model.hits ? [ROW.note] : [])])
    case 'expression':
      // Los dos operandos van en filas distintas: dos puertos en la misma fila se taparían. Catorce
      // píxeles de margen: el extremo plano de un retorno tiene un marco algo mayor que el de una operación.
      return stack([ROW.input, ROW.input]) + 14
    case 'signature':
      // Cada parámetro es una fila (nombre y valor por defecto), y debajo el botón de añadir.
      return stack([...model.params.map(() => ROW.input), ROW.add])
    case 'dict': {
      const shown = full ? model.entries.length : Math.min(1, model.entries.length)
      const hidden = model.entries.length - shown
      return stack([
        ...Array.from({ length: Math.max(1, shown) }, () => ROW.input),
        ...(hidden > 0 ? [ROW.note] : []),
        ROW.add,
      ])
    }
    case 'signal':
      // El tipo de error y su mensaje, cada uno en su fila.
      return stack([ROW.input, ROW.input])
    default:
      return ROW.input
  }
}

/**
 * Un comentario ocupa sitio propio: bajo el título, a lo sumo dos líneas en normal y cuatro en
 * expandido (el resto se lee completo al pasar el ratón). En compacto no cabe: es una píldora.
 */
const NOTE = {
  line: 15,
  gap: 4,
  maxLines: { normal: 2, expanded: 4 },
  charsPerLine: { normal: 34, expanded: 40, territory: 48 },
}

export function noteHeight(note: string | undefined, density: Density): number {
  if (!note?.trim() || density === 'compact') return 0
  const lines = Math.min(NOTE.maxLines[density], wrappedLines(note, NOTE.charsPerLine[density]))
  return lines * NOTE.line + NOTE.gap
}

/** Lo que la cabecera de un territorio necesita para la documentación de su función (hasta tres líneas). */
export function docHeadroom(note: string | undefined): number {
  if (!note?.trim()) return 0
  const lines = Math.min(3, wrappedLines(note, NOTE.charsPerLine.territory))
  return lines * NOTE.line + 8
}

/** Lo que hay que añadir al alto base de la densidad para que el editor y el comentario quepan enteros. */
export function extraHeight(
  model: ControlModel | undefined,
  density: Density,
  linked: readonly string[] = [],
  note?: string,
): number {
  return (
    Math.max(0, controlHeight(model, density, linked) - ROOM[density]) + noteHeight(note, density)
  )
}
