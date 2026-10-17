/**
 * Las **perillas** de un programa: los valores con los que se puede jugar sin tocar el código. El tamaño de
 * la población, cuántas generaciones, la probabilidad de mutar, la frase objetivo, si se enseña cada paso…
 * Se leen del propio programa:
 *
 * - las **constantes** que define en su primer nivel con un valor escrito tal cual (`LONGITUD = 8`,
 *   `OBJETIVO = "hola"`, `COLOR = (255, 0, 0)`): candidatas a su **configuración** (cuáles lo son de verdad
 *   lo dice el JEV; ver `judgeConfig`), y
 * - los valores con los que **arranca** (los de la llamada a una de sus funciones, también en su primer nivel:
 *   `algoritmo_genetico(12, 40)`), con el nombre de lo que esa función recibe.
 *
 * Cada una se maneja como pide su dato: un número, con una perilla que gira; un sí o no, con un interruptor;
 * un texto, escribiéndolo; un color, con su muestra. Moverla escribe ese valor en el programa (es su código:
 * se puede deshacer) y el programa se vuelve a ejecutar. No se inventa nada: solo se ofrece cambiar lo que ya
 * estaba escrito.
 */

/** Un valor escrito tal cual en el programa. */
export type Literal =
  | { type: 'number'; value: number; decimal: boolean }
  | { type: 'bool'; value: boolean }
  | { type: 'str'; value: string; quote: '"' | "'" }
  | { type: 'list'; items: Literal[]; open: '[' | '(' }

export interface Knob {
  /** Cómo se llama: el nombre de la constante, o de lo que la función recibe. */
  name: string
  literal: Literal
  /** Su valor, tal como está escrito. */
  text: string
  /** Dónde está escrito en el programa (de dónde a dónde, en caracteres). */
  start: number
  end: number
  line: number
  /** De dónde sale: una constante del programa, o un dato con el que se arranca. */
  from: 'constant' | 'launch'
}

/**
 * Cómo se maneja un valor (lo que el JEV elige entre lo que su dato admite):
 *
 * - `cantidad`: cuántos, un tamaño, unas vueltas (entero): una perilla que gira a saltos enteros.
 * - `medida`: una magnitud con decimales (una velocidad, un peso): una perilla fina.
 * - `proporcion`: una probabilidad o una fracción, de 0 a 1: una perilla en tantos por ciento.
 * - `interruptor`: sí o no.
 * - `texto`: una palabra o una frase.
 * - `color`: un color (`"#ff0000"` o `(255, 0, 0)`): su muestra.
 * - `lista`: unos cuantos valores.
 */
export type KnobKind =
  'cantidad' | 'medida' | 'proporcion' | 'interruptor' | 'texto' | 'color' | 'lista'

/** Cuántos datos de arranque se ofrecen: más son un panel de mandos, no una ayuda. */
export const MAX_KNOBS = 6
/** Cuántas constantes se le enseñan al JEV como posible configuración. */
export const MAX_CONFIG = 8
/** Una lista más larga no es un ajuste: son datos. */
const MAX_ITEMS = 12

const NUMBER = /^-?\d+(?:\.\d+)?$/

/** Parte por las comas de primer nivel (las de dentro de corchetes, paréntesis o comillas no cuentan). */
function topSplit(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let from = 0
  for (let at = 0; at < text.length; at++) {
    const char = text[at] ?? ''
    if (quote !== '') {
      if (char === '\\') at++
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) depth--
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(from, at))
      from = at + 1
    }
  }
  parts.push(text.slice(from))
  return parts
}

/** Lee un valor escrito tal cual (`8`, `0.1`, `True`, `"hola"`, `[1, 2]`, `(255, 0, 0)`); si no lo es, `null`. */
export function literalOf(written: string): Literal | null {
  const text = written.trim()
  if (NUMBER.test(text)) return { type: 'number', value: Number(text), decimal: text.includes('.') }
  if (text === 'True' || text === 'False') return { type: 'bool', value: text === 'True' }
  const quote = text[0]
  if ((quote === '"' || quote === "'") && text.length >= 2 && text.endsWith(quote)) {
    const inside = text.slice(1, -1)
    // Una comilla igual sin escapar dentro: son dos textos, no uno.
    if (new RegExp(`(^|[^\\\\])(\\\\\\\\)*${quote}`).test(inside)) return null
    return {
      type: 'str',
      value: inside.replace(/\\(.)/g, (_, char: string) =>
        char === 'n' ? '\n' : char === 't' ? '\t' : char,
      ),
      quote,
    }
  }
  const open = text[0]
  if ((open === '[' && text.endsWith(']')) || (open === '(' && text.endsWith(')'))) {
    const inside = text.slice(1, -1).trim()
    if (inside === '') return open === '[' ? { type: 'list', items: [], open } : null
    const parts = topSplit(inside)
    // `(3)` es un número entre paréntesis; una tupla lleva coma.
    if (open === '(' && parts.length < 2) return null
    if (parts[parts.length - 1]?.trim() === '') parts.pop()
    if (parts.length > MAX_ITEMS) return null
    const items = parts.map(literalOf)
    // Solo valores sueltos dentro: una lista de listas son datos, no un ajuste.
    if (items.some((item) => item === null || item.type === 'list')) return null
    return { type: 'list', items: items as Literal[], open }
  }
  return null
}

/** El valor escrito en Python. */
export function literalText(literal: Literal): string {
  switch (literal.type) {
    case 'number':
      return numberText(literal.decimal, literal.value)
    case 'bool':
      return literal.value ? 'True' : 'False'
    case 'str':
      return `${literal.quote}${literal.value
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t')
        .replaceAll(literal.quote, `\\${literal.quote}`)}${literal.quote}`
    case 'list': {
      const inside = literal.items.map(literalText).join(', ')
      return literal.open === '['
        ? `[${inside}]`
        : `(${inside}${literal.items.length === 1 ? ',' : ''})`
    }
  }
}

/** ¿Se le vuelve a dar valor a ese nombre en algún otro sitio del programa (`n += 1`, `n = n * 2`)? */
function changedLater(source: string, name: string): boolean {
  const assigned = new RegExp(
    String.raw`^[ \t]*${name}[ \t]*(?:[+\-*/%&|^]|//|\*\*|<<|>>)?=(?!=)`,
    'gm',
  )
  if ((source.match(assigned)?.length ?? 0) > 1) return true
  // Una lista que el programa va llenando o cambiando es su trabajo, no un ajuste.
  return new RegExp(
    String.raw`\b${name}\s*(?:\.(?:append|extend|insert|pop|remove|clear|sort|reverse|update|add)\s*\(|\[[^\]]*\]\s*(?:[+\-*/%]|//)?=(?!=))`,
  ).test(source)
}

/** Lo que va tras `=` en una línea, sin el comentario del final (un `#` dentro de un texto no lo es). */
function valueAt(rest: string): { text: string; literal: Literal } | null {
  const whole = literalOf(rest)
  if (whole) return { text: rest.trim(), literal: whole }
  for (let at = rest.indexOf('#'); at >= 0; at = rest.indexOf('#', at + 1)) {
    const text = rest.slice(0, at).trim()
    const literal = literalOf(text)
    if (literal) return { text, literal }
  }
  return null
}

/** Las perillas del programa. `functions`: sus funciones, con lo que recibe cada una. */
export function knobsOf(
  source: string,
  functions: readonly { name: string; params: readonly string[] }[] = [],
): Knob[] {
  const knobs: Knob[] = []
  const byName = new Map(functions.map((fn) => [fn.name, fn.params]))
  let offset = 0
  for (const [at, row] of source.split('\n').entries()) {
    const line = row.replace(/\r$/, '')
    const indented = /^\s/.test(line)
    if (!indented && line.trim() !== '' && !line.startsWith('#')) {
      const constant = /^([A-Za-z_]\w*)\s*=(?!=)(.*)$/.exec(line)
      const value = constant ? valueAt(constant[2] ?? '') : null
      if (constant && value) {
        const name = constant[1] ?? ''
        // Un valor que el programa va cambiando (un contador, un total) no es una perilla: es su trabajo.
        if (!changedLater(source, name)) {
          const start = offset + line.indexOf(value.text, name.length + 1)
          knobs.push(knob(name, value, start, at + 1, 'constant'))
        }
      } else {
        // Una llamada a una función del programa, con valores escritos: los datos con los que arranca.
        for (const call of line.matchAll(/\b([A-Za-z_]\w*)\(/g)) {
          const params = byName.get(call[1] ?? '')
          if (!params) continue
          const from = (call.index ?? 0) + call[0].length
          const inside = argsAt(line, from)
          if (inside === null) continue
          let cursor = offset + from
          for (const [index, part] of topSplit(inside).entries()) {
            const text = part.trim()
            // Un dato con nombre (`tamano=20`) se llama como dice; uno suelto, como lo que la función recibe.
            const named = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/s.exec(text)
            const written = (named ? (named[2] ?? '') : text).trim()
            const literal = literalOf(written)
            if (literal && written !== '') {
              const start = cursor + part.lastIndexOf(written)
              knobs.push(
                knob(
                  named?.[1] ?? params[index] ?? `dato ${index + 1}`,
                  { text: written, literal },
                  start,
                  at + 1,
                  'launch',
                ),
              )
            }
            cursor += part.length + 1
          }
        }
      }
    }
    offset += row.length + 1
  }
  // Primero con lo que se arranca (es lo que más se quiere cambiar); luego las constantes.
  return [
    ...knobs.filter((entry) => entry.from === 'launch').slice(0, MAX_KNOBS),
    ...knobs.filter((entry) => entry.from === 'constant').slice(0, MAX_CONFIG),
  ]
}

/** Lo que va entre los paréntesis de una llamada que empieza en `from` (hasta su paréntesis de cierre). */
function argsAt(line: string, from: number): string | null {
  let depth = 1
  let quote = ''
  for (let at = from; at < line.length; at++) {
    const char = line[at] ?? ''
    if (quote !== '') {
      if (char === '\\') at++
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' || char === ']' || char === '}') {
      depth--
      if (depth === 0) return line.slice(from, at)
    }
  }
  return null
}

function knob(
  name: string,
  value: { text: string; literal: Literal },
  start: number,
  line: number,
  from: Knob['from'],
): Knob {
  return {
    name,
    literal: value.literal,
    text: value.text,
    start,
    end: start + value.text.length,
    line,
    from,
  }
}

// ───────────────────────── cómo se maneja cada una ─────────────────────────

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const RATIO_WORDS = /prob|tasa|rate|ratio|porcent|fracci|mutaci|chance|proporci|frecuen/i
const COLOR_WORDS = /colou?r|rgb|fondo|tinta/i

/** Un color de tres números de 0 a 255 (`(255, 0, 0)`). */
const rgbOf = (literal: Literal): [number, number, number] | null =>
  literal.type === 'list' &&
  literal.items.length === 3 &&
  literal.items.every(
    (item) => item.type === 'number' && !item.decimal && item.value >= 0 && item.value <= 255,
  )
    ? (literal.items.map((item) => (item.type === 'number' ? item.value : 0)) as [
        number,
        number,
        number,
      ])
    : null

/** Las formas de manejar un valor que su dato admite (entre ellas elige el JEV). */
export function kindOptions(literal: Literal): KnobKind[] {
  switch (literal.type) {
    case 'number':
      return [
        ...(literal.value >= 0 && literal.value <= 1 ? (['proporcion'] as const) : []),
        ...(literal.decimal
          ? (['medida', 'cantidad'] as const)
          : (['cantidad', 'medida'] as const)),
      ]
    case 'bool':
      return ['interruptor']
    case 'str':
      return HEX.test(literal.value) ? ['color', 'texto'] : ['texto']
    case 'list':
      return rgbOf(literal) ? ['color', 'lista'] : ['lista']
  }
}

/** Cómo se maneja un valor si nadie ha dicho otra cosa: lo que se ve en su dato y en su nombre. */
export function kindGuess(entry: Pick<Knob, 'name' | 'literal'>): KnobKind {
  const { literal } = entry
  switch (literal.type) {
    case 'number':
      if (
        literal.value >= 0 &&
        literal.value <= 1 &&
        (literal.decimal || RATIO_WORDS.test(entry.name))
      ) {
        return 'proporcion'
      }
      return literal.decimal ? 'medida' : 'cantidad'
    case 'bool':
      return 'interruptor'
    case 'str':
      return HEX.test(literal.value) ? 'color' : 'texto'
    case 'list':
      return rgbOf(literal) && (literal.open === '(' || COLOR_WORDS.test(entry.name))
        ? 'color'
        : 'lista'
  }
}

/** Hasta dónde gira la perilla de un número: de 0 (o su negativo) a unas veces lo que vale, en cifras redondas. */
export interface DialRange {
  min: number
  max: number
  step: number
}

/** El primer número «redondo» (1, 2 o 5 por una potencia de diez) que no es menor que `value`. */
function roundUp(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value))
  for (const factor of [1, 2, 5, 10]) if (factor * power >= value) return factor * power
  return 10 * power
}

export function dialRange(value: number, kind: KnobKind): DialRange {
  if (kind === 'proporcion') return { min: 0, max: 1, step: 0.01 }
  const size = Math.abs(value)
  const max = roundUp(Math.max(kind === 'cantidad' ? 10 : 1, size * 3))
  const min = value < 0 ? -max : 0
  const step =
    kind === 'cantidad' ? Math.max(1, roundUp((max - min) / 200)) : roundUp((max - min) / 400)
  return { min, max, step }
}

/**
 * El nuevo valor de una perilla, escrito en Python, a partir de lo que se le dio en el lienzo (un número, un
 * sí o no, un texto, un color `#rrggbb`, o una lista tecleada). Si no vale para ese dato, `null`.
 */
export function knobWritten(
  entry: Pick<Knob, 'literal'>,
  kind: KnobKind,
  given: number | boolean | string,
): string | null {
  const { literal } = entry
  if (literal.type === 'number') {
    const value = typeof given === 'number' ? given : Number(String(given).replace(',', '.'))
    if (!Number.isFinite(value)) return null
    // Una cantidad es entera aunque estuviera escrita con decimales; lo demás conserva cómo era.
    return numberText(
      kind === 'cantidad' ? false : literal.decimal || !Number.isInteger(value),
      value,
    )
  }
  if (literal.type === 'bool') {
    return typeof given === 'boolean' ? literalText({ ...literal, value: given }) : null
  }
  if (literal.type === 'str') {
    return typeof given === 'string' ? literalText({ ...literal, value: given }) : null
  }
  // Una lista: un color de la muestra, o lo que se tecleó.
  if (typeof given !== 'string') return null
  if (kind === 'color' && HEX.test(given)) {
    const rgb = hexRgb(given)
    return literalText({
      ...literal,
      items: rgb.map((value) => ({ type: 'number', value, decimal: false })),
    })
  }
  const typed = given.trim()
  const parsed = literalOf(typed) ?? literalOf(literal.open === '[' ? `[${typed}]` : `(${typed})`)
  if (parsed?.type !== 'list') return null
  return literalText({ ...parsed, open: literal.open })
}

/** Lo que enseña el lienzo de un valor: su número, su sí o no, su texto, su color o sus elementos. */
export function knobShown(entry: Pick<Knob, 'literal'>): {
  number?: number
  bool?: boolean
  text?: string
  color?: string
  items?: string[]
} {
  const { literal } = entry
  switch (literal.type) {
    case 'number':
      return { number: literal.value }
    case 'bool':
      return { bool: literal.value }
    case 'str':
      return HEX.test(literal.value)
        ? { text: literal.value, color: fullHex(literal.value) }
        : { text: literal.value }
    case 'list': {
      const rgb = rgbOf(literal)
      return {
        items: literal.items.map((item) => (item.type === 'str' ? item.value : literalText(item))),
        ...(rgb ? { color: `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}` } : {}),
      }
    }
  }
}

const fullHex = (hex: string) =>
  hex.length === 4
    ? `#${[...hex.slice(1)].map((char) => char + char).join('')}`.toLowerCase()
    : hex.toLowerCase()

function hexRgb(hex: string): [number, number, number] {
  const full = fullHex(hex)
  return [1, 3, 5].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number]
}

/** El número, escrito como va en el programa: sin colas de decimales, y entero si lo era. */
function numberText(decimal: boolean, value: number): string {
  if (!decimal) return String(Math.round(value))
  const text = String(Math.round(value * 1000) / 1000)
  return text.includes('.') ? text : `${text}.0`
}
