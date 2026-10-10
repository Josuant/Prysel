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
  normal: [224, 96],
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

/** Lo que la cabecera de un bucle dibujado como territorio suma para su editor (`para x en …`). */
export const LOOP_HEADROOM = 40

const ROW = { op: 22, input: 30, labeled: 49, note: 18, gap: 6, label: 19, add: 24 }

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

/** Llamadas cuyo nombre ya dice el título del nodo («Imprimir», «Pedir dato»): no repiten su nombre en un campo. */
export const ACTION_CALLS: ReadonlySet<string> = new Set(['print', 'input'])

/**
 * La tarjeta esbelta (densidad normal): solo lo relevante. Su alto sale de lo que lleva dentro, no de
 * un tamaño de serie: el marco de la forma (arriba y abajo), la cabecera (icono, nombre, acción), y el
 * editor con filas más bajas que en expandido.
 */
const SLIM = { frame: 30, head: 21, gap: 4, input: 26, rowGap: 4, note: 16, add: 22, code: 20 }

const slimStack = (rows: number[]) =>
  rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row, 0) + SLIM.rowGap * (rows.length - 1)

/** Lo que mide el editor de una tarjeta esbelta. */
export function slimControlHeight(
  model: ControlModel | undefined,
  linked: readonly string[] = [],
): number {
  if (!model) return 0
  switch (model.kind) {
    case 'text':
      return model.multiline ? areaHeight(model.value, 'normal') : SLIM.input
    case 'args': {
      const isLinked = (name: string) => linked.includes(`arg:${name}`)
      const shown = model.args.filter(
        (a, i) => i === 0 || isLinked(a.name) || model.args.length <= INLINE_ARGS,
      )
      const hidden = model.args.length - shown.length
      return slimStack([
        ...(model.target && !ACTION_CALLS.has(model.target) ? [SLIM.input] : []),
        ...shown.map(() => SLIM.input),
        ...(hidden > 0 ? [SLIM.note] : []),
      ])
    }
    case 'signal':
      return slimStack([SLIM.input, SLIM.input])
    case 'dict': {
      const hidden = Math.max(0, model.entries.length - 1)
      return slimStack([SLIM.input, ...(hidden > 0 ? [SLIM.note] : []), SLIM.add])
    }
    case 'signature':
      return slimStack([...model.params.map(() => SLIM.input), SLIM.add])
    case 'chain':
      // El receptor, un paso por fila y, debajo, dónde escribir uno nuevo.
      return slimStack([SLIM.input, ...model.steps.map(() => SLIM.input), SLIM.add])
    case 'loop':
      // Con progreso (una ejecución en marcha) lleva una fila más.
      return model.total === undefined ? SLIM.input : SLIM.input + SLIM.rowGap + SLIM.note
    default:
      return SLIM.input
  }
}

/**
 * El ancho de una tarjeta esbelta: el de serie, y más si lleva una fórmula (A, operador, B en una
 * fila) o una llamada (su función y cada argumento con su nombre).
 */
export function slimWidth(base: number, model?: ControlModel): number {
  // Cada carácter de un campo ocupa unos 7 px; el resto es el operador, los huecos y el margen.
  const chars = (...texts: string[]) => texts.reduce((sum, text) => sum + text.length, 0) * 7.2
  if (model?.kind === 'expression') {
    return Math.min(440, Math.max(base, 272, Math.ceil(chars(model.left, model.right) + 130)))
  }
  if (model?.kind === 'condition') {
    return Math.min(440, Math.max(base, 272, Math.ceil(chars(model.field, model.value) + 130)))
  }
  if (model?.kind === 'with' || model?.kind === 'handler') {
    const text = model.kind === 'with' ? model.context : model.type
    return Math.min(440, Math.max(base, 236, Math.ceil(chars(text, model.name) + 140)))
  }
  if (model?.kind === 'chain') {
    // Cada fila: `.método(argumentos)` y, a la derecha, lo que se observó de su resultado.
    const longest = Math.max(
      model.receiver.length,
      ...model.steps.map((step) => step.name.length + step.args.length),
    )
    return Math.min(500, Math.max(base, 340, Math.ceil(longest * 7.2 + 250)))
  }
  if (model?.kind === 'args') {
    const longest = Math.max(0, ...model.args.map((arg) => arg.value.length + arg.name.length))
    return Math.min(360, Math.max(base, 236, Math.ceil(longest * 7.2 + 70)))
  }
  return base
}

/**
 * La tarjeta de **una sola línea**: icono, nombre (lo que asigna), y la operación o la llamada con sus
 * casillas al lado — `Σ suma  a + b`, `ƒ x = suma(a, b)`. Solo las operaciones y las llamadas; el
 * resto de nodos sigue apilando cabecera y editor.
 */
export const isLineCard = (kind: string, control: ControlModel | undefined): boolean =>
  control?.kind === 'assign' ||
  ((kind === 'transform.operation' || kind === 'transform.call' || kind === 'effect.io') &&
    (control?.kind === 'expression' || control?.kind === 'args'))

/** Un nombre que Python admite como variable: si el destino de una asignación lo es, va como chip. */
export const isPlainName = (text: string): boolean => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(text.trim())

/** `a` o `a, b, c`: uno o varios nombres, sin nada más. */
export const isNameList = (text: string): boolean =>
  text.split(',').every((part) => isPlainName(part))

/** El título fijo de las llamadas de acción, que ya dicen qué hacen: no se repite su nombre en un campo. */
export const ACTION_TITLES: Readonly<Record<string, string>> = {
  print: 'Imprimir',
  input: 'Pedir dato',
}

/** Un argumento que se llama `arg1` o `valor` no dice nada: solo se rotula el que tiene nombre propio. */
const GENERIC_ARG = /^(arg\d+|valor)$/
export const labelsArgs = (args: readonly { name: string }[]): boolean =>
  args.length > 1 && args.some((arg) => !GENERIC_ARG.test(arg.name))

/**
 * Si un argumento lleva su rótulo en la línea: no cuando lo que se le pasa se llama igual que él
 * (`poblacion=poblacion`), que sería leer dos veces lo mismo y quitarle sitio a lo demás.
 */
export const labelsArg = (arg: { name: string; value: string }): boolean =>
  arg.name !== arg.value.trim()

/** Cuántos argumentos se enseñan en la línea: los de siempre, y los conectados nunca se esconden. */
export function lineArgs<T extends { name: string }>(
  args: readonly T[],
  linked: readonly string[] = [],
): { shown: T[]; hidden: number } {
  const shown = args.filter(
    (arg, index) => index === 0 || args.length <= INLINE_ARGS || linked.includes(`arg:${arg.name}`),
  )
  return { shown, hidden: args.length - shown.length }
}

const CH = 7.8
/**
 * Lo que mide un campo de una línea: su texto, el margen del campo y el sitio de la × del chip o de la
 * flecha del desplegable, que van dentro; con un mínimo para poder escribir.
 */
const lineField = (text: string, min = 60) => Math.max(min, Math.ceil(text.length * CH + 18 + 34))

/**
 * Lo que mide una tarjeta de una línea: el icono, el nombre que asigna (o el título de la acción), y
 * la fórmula o la llamada. El nombre asignado es un chip (`result`): pastilla, y el signo igual.
 */
export function lineWidth(
  model: ControlModel | undefined,
  result: string | readonly string[] | undefined,
  linked: readonly string[] = [],
  /** Lo que ocupan otros elementos de la línea (el chevron que abre la función llamada). */
  extra = 0,
): number {
  const icon = 28
  const gap = 6
  const names = result === undefined ? [] : typeof result === 'string' ? [result] : result
  const chip =
    names.length === 0
      ? 0
      : names.reduce((sum, name) => sum + Math.ceil(name.length * CH + 24) + gap, 0) + 10 + gap
  let inner = 0
  let title = 0
  if (model?.kind === 'expression') {
    inner = lineField(model.left) + gap + 46 + gap + lineField(model.right)
  } else if (model?.kind === 'assign') {
    // Con un nombre de destino, el chip ya lo dice; con otro (`self.x`), un campo propio y su igual.
    inner =
      (isNameList(model.destination) && names.length > 0
        ? 0
        : lineField(model.destination) + gap + 10 + gap) + lineField(model.value, 80)
  } else if (model?.kind === 'args') {
    const action = ACTION_CALLS.has(model.target)
    const label = labelsArgs(model.args)
    const { shown, hidden } = lineArgs(model.args, linked)
    title = action ? Math.ceil((ACTION_TITLES[model.target]?.length ?? 8) * CH + 8) + gap : 0
    inner =
      (model.target && !action ? lineField(model.target, 72) + gap : 0) +
      10 +
      shown.reduce(
        (sum, arg) =>
          sum +
          lineField(arg.value, 60) +
          (label && labelsArg(arg) ? Math.ceil(arg.name.length * 6.4) + 4 : 0) +
          gap,
        0,
      ) +
      (hidden > 0 ? 26 : 0) +
      10
  }
  // Varias pastillas abren la línea con más sitio: sin él, sus campos se aprietan hasta no leerse. Lo que va
  // aparte (el chevron, las pastillas de los subprocesos) no le quita sitio a los campos.
  // El tope es alto a propósito: una llamada con varios argumentos largos tiene que caber entera. Más
  // estrecha, sus casillas se montan unas sobre otras y el nombre de la función se corta.
  const cap = (names.length > 1 ? 1200 : 1100) + extra
  return Math.min(cap, Math.max(180, 30 + icon + gap + chip + title + inner + extra))
}

/** El alto de una tarjeta de una línea: el marco y una fila (más su comentario, si lo tiene). */
export function lineHeight(note?: string): number {
  return Math.ceil(SLIM.frame + SLIM.input + noteHeight(note, 'normal'))
}

/**
 * El alto de una tarjeta esbelta que lleva ese editor, ese comentario y, si no tiene editor, su
 * código. Cabe justo: sin aire de más arriba ni abajo.
 */
export function slimHeight(
  model: ControlModel | undefined,
  linked: readonly string[] = [],
  note?: string,
  hasCode = false,
): number {
  const body = model ? slimControlHeight(model, linked) + SLIM.gap : hasCode ? SLIM.code : 0
  return Math.ceil(SLIM.frame + SLIM.head + SLIM.gap + body + noteHeight(note, 'normal'))
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
        ...(model.target ? [ROW.input] : []),
        // En una tarjeta esbelta el nombre del argumento va a la izquierda del campo, no encima.
        ...shown.map(() => (labeled && full ? ROW.labeled : ROW.input)),
        ...(hidden > 0 ? [ROW.note] : []),
      ])
    }
    case 'condition':
      // Esbelta: campo, operador y valor en una fila. Expandida: apilados, con sus marcadores.
      return full ? stack([ROW.input, ROW.input, ...(model.hits ? [ROW.note] : [])]) : ROW.input
    case 'chain':
      return stack([ROW.input, ...model.steps.map(() => ROW.input), ROW.add])
    case 'assign':
      // Destino y valor: en una fila cuando cabe; apilados en expandido.
      return full ? stack([ROW.input, ROW.input]) : ROW.input
    case 'expression':
      // La fórmula: operando, operador y operando. En una fila cuando cabe (los puertos se reparten
      // a lo alto del borde); apilados en expandido.
      return full ? stack([ROW.input, ROW.op, ROW.input]) : ROW.input
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

/**
 * Una **etapa**: la tarjeta de una fase del algoritmo cuando está plegada, y su cabecera cuando está abierta.
 * La tarjeta lleva su número y su título; debajo, el subtítulo; luego lo que usa de antes → lo que deja
 * para después (como chips) y, en otra fila, los subprocesos a los que llama y lo que esconde (↻, ◇).
 */
export const SECTION = {
  pad: 12,
  badge: 26,
  gap: 6,
  head: 26,
  sub: 17,
  row: 24,
  min: 260,
  max: 440,
  /** Cuántos chips caben a cada lado de la flecha; el resto se cuenta («+2»). */
  uses: 3,
  leaves: 4,
  /** Dicha solo con palabras (en la arquitectura): lo que cabe en una línea del subtítulo, y su ancho mínimo. */
  plainLine: 34,
  plainMin: 200,
} as const

/** Lo que mide un chip o una pastilla con ese nombre en una tarjeta de etapa. */
export const sectionChipWidth = (name: string) => Math.ceil(name.length * 6.8 + 22)

/**
 * Cómo van los chips de una tarjeta de etapa de ese ancho: en una fila (lo que usa → lo que deja) si caben,
 * o en dos (lo que usa arriba; → lo que deja, debajo). En cada fila se enseñan los que caben y el resto se
 * cuenta («+2»).
 */
export function sectionFlowFit(
  uses: readonly string[],
  leaves: readonly string[],
  width: number,
): { rows: 0 | 1 | 2; uses: number; leaves: number } {
  if (uses.length + leaves.length === 0) return { rows: 0, uses: 0, leaves: 0 }
  const room = width - (SECTION.pad + SECTION.badge + 10) - SECTION.pad
  const cost = (names: readonly string[], n: number) =>
    names.slice(0, n).reduce((sum, name) => sum + Math.min(160, sectionChipWidth(name)) + 4, 0) +
    (n < names.length ? 30 : 0)
  const u = Math.min(uses.length, SECTION.uses)
  const l = Math.min(leaves.length, SECTION.leaves)
  const arrow = u > 0 && l > 0 ? 22 : 0
  if (cost(uses, u) + arrow + cost(leaves, l) <= room) return { rows: 1, uses: u, leaves: l }
  let fu = u
  let fl = l
  while (fu > 1 && cost(uses, fu) > room) fu--
  while (fl > 1 && cost(leaves, fl) + 22 > room) fl--
  return { rows: u > 0 && l > 0 ? 2 : 1, uses: fu, leaves: fl }
}

export function sectionCardSize(card: {
  title: string
  subtitle?: string | undefined
  uses: readonly string[]
  leaves: readonly string[]
  callees: readonly string[]
  /** Cuántos glifos de lo que esconde (bucle, decisión, salida) lleva. */
  glyphs: number
  /**
   * Dicha solo con palabras: su título y su subtítulo (en dos líneas si es largo), sin los nombres del código
   * (lo que usa, lo que deja, a quién llama). Así es un módulo en la arquitectura: se lee de lejos, y el
   * código queda a un gesto (abrirla).
   */
  plain?: boolean
}): { w: number; h: number } {
  const indent = SECTION.pad + SECTION.badge + 10
  if (card.plain) {
    const text = card.subtitle ?? ''
    const lines = text.length === 0 ? 0 : text.length > SECTION.plainLine ? 2 : 1
    const perLine =
      lines === 2 ? Math.min(SECTION.plainLine + 6, Math.ceil(text.length / 2) + 6) : text.length
    const width = Math.max(
      // El número, el papel, el título y el botón de abrirla.
      indent + SECTION.badge + Math.ceil(card.title.length * 8.2) + 10 + 20 + SECTION.pad,
      // Con un poco de holgura: si el texto no cabe en sus líneas, se corta.
      lines === 0 ? 0 : indent + perLine * 6.9 + SECTION.pad + 8,
    )
    return {
      w: snap(clamp(width, SECTION.plainMin, SECTION.max)),
      // Bajo la cabecera, el hueco de la tarjeta y sus líneas.
      h: snap(
        SECTION.pad * 2 + SECTION.head + (lines === 0 ? 0 : SECTION.gap + lines * SECTION.sub),
      ),
    }
  }
  const chips = (names: readonly string[], max: number) =>
    names.slice(0, max).reduce((sum, name) => sum + sectionChipWidth(name) + 4, 0) +
    (names.length > max ? 30 : 0)
  const flow = card.uses.length + card.leaves.length > 0
  const rows = [
    indent + Math.ceil(card.title.length * 8.2) + 10 + 20 + SECTION.pad,
    card.subtitle ? indent + Math.min(64, card.subtitle.length) * 6.6 + SECTION.pad : 0,
    flow
      ? indent +
        chips(card.uses, SECTION.uses) +
        22 +
        chips(card.leaves, SECTION.leaves) +
        SECTION.pad
      : 0,
    card.callees.length + card.glyphs > 0
      ? indent +
        card.callees.reduce((sum, name) => sum + sectionChipWidth(name) + 16 + 4, 0) +
        card.glyphs * 22 +
        SECTION.pad
      : 0,
  ]
  const w = snap(clamp(Math.max(...rows), SECTION.min, SECTION.max))
  const fit = sectionFlowFit(card.uses, card.leaves, w)
  const h =
    SECTION.pad * 2 +
    SECTION.head +
    (card.subtitle ? SECTION.sub : 0) +
    fit.rows * (SECTION.gap + SECTION.row) +
    (card.callees.length + card.glyphs > 0 ? SECTION.gap + SECTION.row : 0)
  return { w, h: snap(h) }
}

/**
 * Lo que ocupan en una fila las pastillas de los subprocesos de un nodo (`↗ volar`): su icono, su nombre y el
 * hueco entre ellas.
 */
export const opensWidth = (names: readonly string[]) =>
  names.length === 0 ? 0 : names.reduce((sum, name) => sum + sectionChipWidth(name) + 20, 0) + 6

/**
 * Lo que pide la cabecera de una etapa abierta sobre la de cualquier territorio (`SCOPE_FRAME.top`, donde ya
 * caben su número y su título): un poco más si lleva subtítulo debajo.
 */
export const sectionHeadroom = (subtitle?: string) => (subtitle ? 10 : 0)

/**
 * El rombo de una bifurcación, leído como diagrama de flujo: pequeño, debajo de la pregunta, justo donde el
 * camino se parte («sí» sale por su vértice de abajo, «no» por el de la derecha). `gap` es el tramo de espina
 * entre la pregunta y el rombo.
 */
export const GATEWAY = { size: 26, gap: 14 } as const

/**
 * Lo que mide una decisión leída como diagrama de flujo: la pregunta en una píldora de una línea
 * (`¿ campo operador valor ?`, con su icono) y, debajo, el rombo de la bifurcación.
 */
export function questionSize(
  model: ControlModel | undefined,
  density: Density,
  label: string,
  code?: string,
): { w: number; h: number } {
  const compact = density === 'compact'
  const pill = compact ? DENSITY_BASE.compact[1] : lineHeight()
  // El icono, los signos de pregunta a cada lado y lo que va entre ellos.
  const chrome = 28 + 6 + 2 * 16
  const content = compact
    ? 22 + label.length * 7 + 26
    : model?.kind === 'condition'
      ? // Cada campo puede llevar un chip (su nombre y la × para quitarlo): algo más que su texto.
        chrome + lineField(model.field) + 16 + 6 + 50 + 6 + lineField(model.value) + 16
      : chrome + Math.min(60, (code ?? label).length) * 7.4
  return {
    w: snap(Math.max(compact ? 150 : 200, content + 30)),
    h: pill + GATEWAY.gap + GATEWAY.size,
  }
}
