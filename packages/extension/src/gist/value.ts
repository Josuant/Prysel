import { isShownList, type Shown } from '../trace.ts'

/**
 * Un valor de Python con su forma, para poder dibujarlo como lo que es (una rejilla, una lista de celdas, un
 * diccionario) y no como un texto. La traza guarda los valores compuestos como su `repr`; aquí se vuelve a
 * leer ese texto. Lo que no se entiende entero no se adivina: queda como texto (`opaque`).
 */
export type Value =
  | { kind: 'atom'; type: 'number' | 'text' | 'bool' | 'none'; text: string }
  | { kind: 'list'; shape: 'list' | 'tuple' | 'set'; items: Value[]; more: boolean }
  | { kind: 'dict'; entries: [Value, Value][]; more: boolean }
  | { kind: 'opaque'; text: string }

const NUMBER = /^[+-]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/
const NAME = /^[A-Za-z_]\w*/

/** Lee un texto de Python de izquierda a derecha. `strict`: solo literales enteros (sin «…» de recorte). */
class Reader {
  at = 0
  constructor(
    readonly text: string,
    readonly strict: boolean,
  ) {}

  space() {
    while (/\s/.test(this.text[this.at] ?? '')) this.at++
  }

  take(token: string): boolean {
    this.space()
    if (!this.text.startsWith(token, this.at)) return false
    this.at += token.length
    return true
  }

  match(pattern: RegExp): string | null {
    this.space()
    const found = pattern.exec(this.text.slice(this.at))?.[0]
    if (found === undefined) return null
    this.at += found.length
    return found
  }

  get done(): boolean {
    this.space()
    return this.at >= this.text.length
  }

  /** Un texto entre comillas, con sus escapes; `null` si no se cierra. */
  string(): string | null {
    this.space()
    const quote = this.text[this.at]
    if (quote !== '"' && quote !== "'") return null
    for (let i = this.at + 1; i < this.text.length; i++) {
      const char = this.text[i]
      if (char === '\\') i++
      else if (char === '\n') return null
      else if (char === quote) {
        const found = this.text.slice(this.at, i + 1)
        this.at = i + 1
        return found
      }
    }
    return null
  }

  /** Los elementos hasta `close`. Un «...» (lo que el motor recorta) vale solo si no se pide estricto. */
  items(close: string): { items: Value[]; more: boolean } | null {
    const items: Value[] = []
    let more = false
    for (;;) {
      if (this.take(close)) return { items, more }
      if (this.take('...')) {
        if (this.strict) return null
        more = true
      } else {
        const item = this.value()
        if (!item) return null
        items.push(item)
      }
      if (this.take(close)) return { items, more }
      if (!this.take(',')) return null
    }
  }

  value(): Value | null {
    const text = this.string()
    if (text !== null) return { kind: 'atom', type: 'text', text }
    if (this.take('[')) {
      const list = this.items(']')
      return list && { kind: 'list', shape: 'list', ...list }
    }
    if (this.take('(')) {
      const list = this.items(')')
      return list && { kind: 'list', shape: 'tuple', ...list }
    }
    if (this.take('{')) {
      if (this.take('}')) return { kind: 'dict', entries: [], more: false }
      const start = this.at
      const first = this.value()
      if (first && this.take(':')) {
        this.at = start
        return this.dict()
      }
      this.at = start
      const set = this.items('}')
      return set && { kind: 'list', shape: 'set', ...set }
    }
    const number = this.match(NUMBER)
    if (number !== null) return { kind: 'atom', type: 'number', text: number }
    const name = this.match(NAME)
    if (name === 'True' || name === 'False') return { kind: 'atom', type: 'bool', text: name }
    if (name === 'None') return { kind: 'atom', type: 'none', text: name }
    return null
  }

  dict(): Value | null {
    const entries: [Value, Value][] = []
    let more = false
    for (;;) {
      if (this.take('}')) return { kind: 'dict', entries, more }
      if (this.take('...')) {
        if (this.strict) return null
        more = true
      } else {
        const key = this.value()
        if (!key || !this.take(':')) return null
        const value = this.value()
        if (!value) return null
        entries.push([key, value])
      }
      if (this.take('}')) return { kind: 'dict', entries, more }
      if (!this.take(',')) return null
    }
  }
}

/** El valor que escribe ese texto de Python, si es un literal entero; `null` si no lo es. */
export function parseLiteral(text: string, strict = false): Value | null {
  const reader = new Reader(text, strict)
  const value = reader.value()
  return value && reader.done ? value : null
}

/** El valor que la traza guardó, con su forma. */
export function valueOf(shown: Shown | undefined): Value {
  if (shown === null || shown === undefined) return { kind: 'atom', type: 'none', text: 'None' }
  if (typeof shown === 'boolean')
    return { kind: 'atom', type: 'bool', text: shown ? 'True' : 'False' }
  if (typeof shown === 'number') return { kind: 'atom', type: 'number', text: String(shown) }
  if (isShownList(shown))
    return {
      kind: 'list',
      shape: shown.t,
      items: shown.l.map((item) => valueOf(item)),
      more: shown.n > shown.l.length,
    }
  return parseLiteral(shown) ?? { kind: 'opaque', text: shown }
}

/** El valor, otra vez como texto de Python. */
export function showValue(value: Value): string {
  if (value.kind === 'atom' || value.kind === 'opaque') return value.text
  const rest = value.more ? ['…'] : []
  if (value.kind === 'dict') {
    const entries = value.entries.map(([key, item]) => `${showValue(key)}: ${showValue(item)}`)
    return `{${[...entries, ...rest].join(', ')}}`
  }
  const items = [...value.items.map(showValue), ...rest].join(', ')
  if (value.shape === 'list') return `[${items}]`
  if (value.shape === 'set') return `{${items}}`
  return value.items.length === 1 && !value.more ? `(${items},)` : `(${items})`
}

/** Las filas de una rejilla: una lista de listas del mismo largo, de valores sueltos. `null` si no lo es. */
export function matrixOf(value: Value): Value[][] | null {
  if (value.kind !== 'list' || value.shape === 'set' || value.items.length === 0) return null
  const rows: Value[][] = []
  for (const row of value.items) {
    if (row.kind !== 'list' || row.shape === 'set' || row.more || row.items.length === 0)
      return null
    if (row.items.some((cell) => cell.kind !== 'atom')) return null
    rows.push(row.items)
  }
  return rows.every((row) => row.length === rows[0]?.length) ? rows : null
}

/** Una llamada escrita solo con literales: `f(1, [2, 3])` o `Clase(1).metodo("a", veces=2)`. */
export interface LiteralCall {
  /** La función, o la clase de la que se crea el objeto. */
  name: string
  /** El método que se llama sobre el objeto recién creado. */
  method?: string
  /** La llamada, tal como hay que escribirla. */
  text: string
}

/**
 * Lee una llamada que no puede hacer nada por sí misma: una sola llamada (o crear un objeto y llamar a uno de
 * sus métodos) cuyos argumentos son literales, sin nombres ni otras llamadas dentro. `null` si no lo es.
 */
export function parseCall(text: string): LiteralCall | null {
  const source = text.trim()
  const reader = new Reader(source, true)
  const args = (): boolean => {
    if (!reader.take('(')) return false
    for (;;) {
      if (reader.take(')')) return true
      const start = reader.at
      // Un argumento con nombre: `veces=2` (pero no `a == b`).
      if (!(reader.match(NAME) !== null && reader.take('=') && !reader.take('='))) reader.at = start
      if (!reader.value()) return false
      if (reader.take(')')) return true
      if (!reader.take(',')) return false
    }
  }
  const name = reader.match(NAME)
  if (name === null || !args()) return null
  if (reader.done) return { name, text: source }
  if (!reader.take('.')) return null
  const method = reader.match(NAME)
  if (method === null || !args() || !reader.done) return null
  return { name, method, text: source }
}
