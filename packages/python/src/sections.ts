/**
 * Las **etapas** de un bloque: los tramos de sentencias seguidas que abre un comentario de sección.
 *
 * Un algoritmo largo no se entiende sentencia a sentencia: se entiende por sus fases («probar», «juzgar»,
 * «criar»). Quien escribe el código ya las marca con un comentario tras una línea en blanco, como el
 * título de un párrafo; aquí se reconocen para que el lienzo pueda plegar cada fase en una tarjeta con
 * su nombre. Es solo lectura del texto: no cambia ninguna sentencia ni su orden.
 *
 * Qué comentario abre una etapa:
 * - **Explícito**: una celda (`# %% Título`, como las de VS Code y Jupytext) o un rótulo con adornos
 *   (`# ── Título ──`, `# === Título ===`). Basta uno.
 * - **Implícito**: un comentario al principio del bloque o tras una línea en blanco, siempre que el bloque
 *   tenga **al menos dos**. Un comentario suelto sigue siendo la nota de su sentencia, como siempre.
 */

/** Una etapa: su rótulo y las sentencias directas del bloque que abarca. */
export interface ProgramSection {
  /** `section:línea:columna` del rótulo. */
  id: string
  /** Lo que se lee en la tarjeta: la primera línea del rótulo, sin adornos, hasta los dos puntos. */
  title: string
  /** Lo que sigue a los dos puntos (`Probar: cada pájaro vuela` → `cada pájaro vuela`). */
  subtitle?: string
  /** Las demás líneas del rótulo, si las hay. */
  note?: string
  /** El texto que se edita al renombrarla: la primera línea sin almohadilla, `%%`, adornos ni numeración. */
  text: string
  /** Dónde está ese texto en el archivo: renombrar la etapa reescribe solo esto. */
  textAt: { start: number; end: number }
  /** Dónde está el rótulo entero (todas sus líneas): quitar la etapa lo borra. */
  heading: { start: number; end: number }
  /** La sentencia dueña del bloque (una función, un bucle, una rama); sin ella, es del programa. */
  owner?: string
  /** Las sentencias directas del bloque que abarca, en orden (lo que tienen dentro va con ellas). */
  members: string[]
  /** La línea del rótulo (base 1). */
  line: number
  /** La última línea de su última sentencia. */
  lineEnd: number
  /** Es una celda o un rótulo con adornos: no necesita otra etapa en el bloque para contar. */
  explicit: boolean
}

/** Un elemento de un bloque, tal como lo necesita la búsqueda de rótulos: dónde está y qué es. */
export interface BlockItem {
  kind: 'comment' | 'statement'
  /** Fila de inicio y de fin (base 0). */
  row: number
  endRow: number
  col: number
  start: number
  end: number
  /** En un comentario, su texto tal cual (con la almohadilla); `null` si no es prosa (shebang, codificación). */
  raw?: string | null
  /** Una sentencia que no cuenta (el docstring): ni corta la serie de comentarios ni hace de sentencia anterior. */
  skip?: boolean
}

/** Un rótulo reconocido en un bloque. */
export interface Heading {
  /** Dónde empieza su primer comentario: con esto se reconoce al recorrer el bloque. */
  start: number
  /** Dónde acaba su último comentario. */
  end: number
  row: number
  col: number
  /** Dónde empieza cada uno de sus comentarios: ninguno es nota de nadie. */
  comments: ReadonlySet<number>
  explicit: boolean
  text: string
  textAt: { start: number; end: number }
  note?: string
}

/** Los adornos con que se subraya un rótulo. */
const RULE_CHARS = '─━═—–\\-=*~_#·•'
const RULE_START = new RegExp(`^[${RULE_CHARS}]{2,}\\s*`, 'u')
const RULE_END = new RegExp(`\\s*[${RULE_CHARS}]{2,}\\s*$`, 'u')
/** Una numeración al principio (`1.`, `2.3)`, `Paso 2:`): el lienzo ya numera las etapas. */
const NUMBERING =
  /^(?:(?:paso|etapa|fase|step)\s+\d{1,2}(?:\.\d{1,2})*\s*[.):·-]?|\d{1,2}(?:\.\d{1,2})*\s*[.):])\s+/iu

/**
 * Lo que dice la primera línea de un comentario como rótulo: su texto (sin almohadilla, `%%`, adornos ni
 * numeración), dónde empieza dentro del comentario y si es explícito. `null` si no dice nada.
 */
export function headingLine(
  raw: string,
): { explicit: boolean; text: string; offset: number } | null {
  let at = /^#+\s*/u.exec(raw)?.[0].length ?? 0
  let explicit = false
  const cell = /^%%\s*/u.exec(raw.slice(at))
  if (cell) {
    // `# %% [markdown]` abre una celda de texto, no de código.
    if (/^\[markdown\]/iu.test(raw.slice(at + cell[0].length))) return null
    explicit = true
    at += cell[0].length
  }
  const rule = RULE_START.exec(raw.slice(at))
  if (rule) {
    explicit = true
    at += rule[0].length
  }
  const numbering = NUMBERING.exec(raw.slice(at))
  if (numbering) at += numbering[0].length
  let text = raw.slice(at)
  const tail = RULE_END.exec(text)
  if (tail) {
    explicit = true
    text = text.slice(0, tail.index)
  }
  text = text.trimEnd()
  if (!/[\p{L}\p{N}]/u.test(text)) return null
  return { explicit, text, offset: at }
}

/**
 * El título y el subtítulo de un rótulo: `Probar: cada pájaro vuela` → «Probar» y «cada pájaro vuela»;
 * `¿Sigue vivo? Si no, acaba` → «¿Sigue vivo?» y «Si no, acaba». Sin nada de eso, todo es título.
 */
export function splitTitle(text: string): { title: string; subtitle?: string } {
  const question = /^(¿[^?]{1,46}\?)\s+(\S.*)$/u.exec(text)
  const colon = question ? null : /^([^:—–]{1,48}?)\s*[:—–]\s+(\S.*)$/u.exec(text)
  const match = question ?? colon
  if (!match?.[1] || !match[2]) return { title: text.trim() }
  return { title: match[1].trim(), subtitle: match[2].trim() }
}

/** El texto de un comentario sin la almohadilla (como lo guarda una nota). */
const plain = (raw: string) => raw.replace(/^#+\s?/u, '').trimEnd()

/**
 * Los rótulos de un bloque, en orden. Vacío si el bloque no tiene etapas: ni un rótulo explícito ni al
 * menos dos implícitos.
 *
 * Entre una sentencia y la siguiente puede haber varios grupos de comentarios (separados por líneas en
 * blanco). El rótulo es el primero explícito o, si no hay ninguno, el primero que viene tras una línea en
 * blanco (o al principio del bloque). Los demás siguen siendo notas de la sentencia.
 */
export function blockHeadings(items: readonly BlockItem[]): Heading[] {
  const found: Heading[] = []
  let run: BlockItem[] = []
  /** La fila en que acaba la sentencia anterior; `null` al principio del bloque. */
  let previous: number | null = null
  for (const item of items) {
    if (item.kind === 'comment') {
      // Un comentario en la línea de la sentencia anterior es su apostilla, no el principio de nada.
      if (previous !== null && item.row === previous) continue
      if (item.raw) run.push(item)
      continue
    }
    if (item.skip) continue
    const heading = headingIn(run, previous)
    if (heading) found.push(heading)
    run = []
    previous = item.endRow
  }
  return found.some((heading) => heading.explicit) || found.length >= 2 ? found : []
}

function headingIn(run: readonly BlockItem[], previous: number | null): Heading | null {
  const groups: BlockItem[][] = []
  for (const comment of run) {
    const group = groups[groups.length - 1]
    const tail = group?.[group.length - 1]
    if (group && tail && comment.row === tail.endRow + 1) group.push(comment)
    else groups.push([comment])
  }
  let above = previous
  let chosen: { group: BlockItem[]; line: NonNullable<ReturnType<typeof headingLine>> } | null =
    null
  for (const group of groups) {
    const first = group[0]
    const last = group[group.length - 1]
    if (!first || !last) continue
    const separated = above === null || first.row > above + 1
    above = last.endRow
    const line = headingLine(first.raw ?? '')
    if (!line) continue
    if (line.explicit) {
      chosen = { group, line }
      break
    }
    if (separated && !chosen) chosen = { group, line }
  }
  if (!chosen) return null
  const { group, line } = chosen
  const first = group[0]
  const last = group[group.length - 1]
  if (!first || !last) return null
  const rest = group
    .slice(1)
    .map((comment) => plain(comment.raw ?? ''))
    .join('\n')
    .trim()
  const textStart = first.start + line.offset
  return {
    start: first.start,
    end: last.end,
    row: first.row,
    col: first.col,
    comments: new Set(group.map((comment) => comment.start)),
    explicit: line.explicit,
    text: line.text,
    textAt: { start: textStart, end: textStart + line.text.length },
    ...(rest ? { note: rest } : {}),
  }
}

/** La etapa que abre un rótulo, con su primera sentencia. */
export function openSection(
  heading: Heading,
  owner: string | undefined,
  first: string,
): ProgramSection {
  const { title, subtitle } = splitTitle(heading.text)
  return {
    id: `section:${heading.row + 1}:${heading.col}`,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(heading.note ? { note: heading.note } : {}),
    text: heading.text,
    textAt: heading.textAt,
    heading: { start: heading.start, end: heading.end },
    ...(owner === undefined ? {} : { owner }),
    members: [first],
    line: heading.row + 1,
    lineEnd: heading.row + 1,
    explicit: heading.explicit,
  }
}
