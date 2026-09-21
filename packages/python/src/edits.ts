import type { ControlModel, NodeAction, TemplateId } from '@prysel/morphology'
import type { Program, ProgramNode } from './program.ts'
import type { Source, Span, TextEdit } from './source.ts'

/**
 * De «esto cambió en el diagrama» a «reescribe estos caracteres del archivo».
 *
 * Es la mitad de escribir de vuelta que no necesita ni el editor ni el analizador: recibe el
 * programa tal como se analizó y lo que hizo el usuario, y devuelve las ediciones mínimas de
 * texto. Vive aparte de `index.ts` para que el webview pueda usarla sin arrastrar tree-sitter
 * (por eso solo importa tipos).
 *
 * Cubre dos clases de cambio:
 * - **de un campo**: un número, un operador, el nombre de una variable (con todos sus usos)…
 * - **de estructura**: reescribir una sentencia como código, eliminarla, duplicarla, añadir otra.
 */

export type { NodeRange, Source, Span, TextEdit } from './source.ts'

export interface Editable {
  control?: ControlModel
  sources?: Record<string, Source>
  names?: Record<string, Span[]>
  renames?: Record<string, string>
}

type Scalar = string | number | boolean

// ───────────────────────── campos ─────────────────────────

/** El valor de un campo del editor por su camino: `left`, `args.a`, `params.minimo`, `params[0].name`… */
function valueAt(model: ControlModel, path: string): Scalar | undefined {
  if (path.startsWith('args.') && model.kind === 'args') {
    return model.args.find((arg) => arg.name === path.slice('args.'.length))?.value
  }
  const indexed = /^params\[(\d+)\]\.name$/.exec(path)
  if (indexed && model.kind === 'signature') return model.params[Number(indexed[1])]?.name
  if (path.startsWith('params.') && model.kind === 'signature') {
    return model.params.find((param) => param.name === path.slice('params.'.length))?.value
  }
  const value = (model as unknown as Record<string, unknown>)[path]
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined
}

/**
 * Escapa un texto para ponerlo dentro de una cadena con ese delimitador. Lo que se enseña en el
 * editor es el contenido tal como está escrito (con sus barras), así que aquí solo se protege lo
 * que rompería la cadena: el delimitador, los saltos de línea de una cadena de una línea, y una
 * barra suelta al final que se comería la comilla de cierre.
 */
export function escapeString(text: string, quote: string): string {
  const mark = quote[0] ?? '"'
  if (quote.length === 3) {
    // Entre comillas triples solo estorba la secuencia que las cerraría (y una comilla al final).
    const escaped = text.includes(quote) ? text.split(mark).join(`\\${mark}`) : text
    return escaped.endsWith(mark) && !escaped.endsWith(`\\${mark}`)
      ? `${escaped.slice(0, -1)}\\${mark}`
      : escaped
  }
  const escaped = text.replace(/\\[\s\S]|[\s\S]/g, (piece) => {
    if (piece === mark) return `\\${mark}`
    if (piece === '\n') return '\\n'
    if (piece === '\r') return '\\r'
    return piece
  })
  const trailing = /\\*$/.exec(escaped)?.[0].length ?? 0
  return trailing % 2 === 1 ? `${escaped}\\` : escaped
}

/** El texto con el que se reescribe un campo, o `null` si ese valor no se puede escribir. */
function render(source: Source, value: Scalar): string | null {
  switch (source.as) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return null
      // Un flotante sigue siendo un flotante: `5.0` no pasa a `5`.
      const original = source.original ?? ''
      return Number.isInteger(n) && /\./.test(original) && !/[eE]/.test(original)
        ? n.toFixed(1)
        : String(n)
    }
    case 'boolean':
      return value === true || value === 'True' ? 'True' : 'False'
    case 'string':
      return escapeString(String(value), source.quote ?? '"')
    case 'operator':
    case 'expression': {
      const text = String(value).trim()
      // Una expresión vacía o de varias líneas rompería la estructura del código: no se escribe.
      return text === '' || /[\r\n]/.test(text) ? null : text
    }
    case 'list':
      // Un contenido delimitado se reescribe con `listContent`, que necesita el editor entero.
      return null
  }
}

/** El contenido de una lista, un diccionario o unos parámetros, tal como quedaría con los cambios del editor. */
function listContent(path: string, before: ControlModel, after: ControlModel): string | null {
  if (path === 'items' && before.kind === 'list' && after.kind === 'list') {
    return JSON.stringify(before.items) === JSON.stringify(after.items)
      ? null
      : after.items
          .map((item) => item.trim())
          .filter(Boolean)
          .join(', ')
  }
  if (path === 'entries' && before.kind === 'dict' && after.kind === 'dict') {
    return JSON.stringify(before.entries) === JSON.stringify(after.entries)
      ? null
      : after.entries
          .filter(([key]) => key.trim() !== '')
          .map(([key, value]) => `${key.trim()}: ${value.trim() || 'None'}`)
          .join(', ')
  }
  if (path === 'paramsList' && before.kind === 'signature' && after.kind === 'signature') {
    // Cuando se añade o se quita un parámetro, o cuando un parámetro gana o pierde su valor por
    // defecto (no había un sitio donde escribirlo, o no puede quedar vacío). Cambiar el valor de un
    // parámetro que ya tenía uno lo hacen sus propios campos.
    const rewritten =
      before.params.length !== after.params.length ||
      after.params.some((param, i) => {
        const was = before.params[i]
        return (
          was !== undefined &&
          was.name === param.name &&
          was.value !== param.value &&
          (was.value.trim() === '' || param.value.trim() === '')
        )
      })
    if (!rewritten) return null
    return after.params
      .filter((param) => param.name.trim() !== '')
      .map((param) =>
        param.value.trim() ? `${param.name.trim()}=${param.value.trim()}` : param.name.trim(),
      )
      .join(', ')
  }
  return null
}

const KEYWORDS = new Set(
  (
    'False None True and as assert async await break class continue def del elif else except ' +
    'finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'
  ).split(' '),
)

/** ¿Es un nombre que Python admite para una variable, una función o un parámetro? */
export function isIdentifier(name: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) && !KEYWORDS.has(name)
}

/** Cambia un nombre en todos los sitios donde este nodo lo define o lo usa. */
export function renameEdits(node: Editable, from: string, to: string): TextEdit[] {
  if (from === to || !isIdentifier(to)) return []
  return (node.names?.[from] ?? []).map((at) => ({ start: at.start, end: at.end, text: to }))
}

/**
 * Las ediciones que convierten el nodo tal como se analizó en el editor tal como lo dejó el
 * usuario. Solo cambian los campos que cambiaron, y solo los que tienen un sitio en el texto.
 */
export function editsFor(node: Editable, next: ControlModel): TextEdit[] {
  const { control, sources } = node
  if (!control || control.kind !== next.kind) return []
  const edits: TextEdit[] = []

  for (const [path, source] of Object.entries(sources ?? {})) {
    if (source.as === 'list') {
      const content = listContent(path, control, next)
      if (content !== null) {
        // Reescribir la lista entera pisa cualquier edición de un elemento suyo: manda la lista.
        return [{ start: source.start, end: source.end, text: content }]
      }
      continue
    }
    const before = valueAt(control, path)
    const after = valueAt(next, path)
    if (after === undefined || before === after) continue
    const text = render(source, after)
    if (text !== null) edits.push({ start: source.start, end: source.end, text })
  }

  // Un nombre no se reescribe en un sitio: se cambia en todos los que lo usan.
  for (const [path, current] of Object.entries(node.renames ?? {})) {
    const after = valueAt(next, path)
    if (typeof after === 'string' && after !== current)
      edits.push(...renameEdits(node, current, after))
  }
  return edits.sort((a, b) => a.start - b.start)
}

/** ¿Son ediciones seguras para un texto de esa longitud? Ordenadas, sin pisarse y dentro del texto. */
export function validEdits(edits: readonly TextEdit[], length: number): boolean {
  let previousEnd = 0
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    const { start, end, text } = edit
    if (!Number.isInteger(start) || !Number.isInteger(end) || typeof text !== 'string') return false
    if (start < previousEnd || end < start || end > length) return false
    previousEnd = end
  }
  return true
}

/** Aplica ediciones a un texto. Sirve donde no hay un editor que lo haga (la galería, los tests). */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}

// ───────────────────────── estructura ─────────────────────────

/** El resultado de una operación de estructura: qué reescribir y, si crea algo, dónde quedará. */
export interface Change {
  edits: TextEdit[]
  /** La línea (base 1) de lo que se acaba de crear, para enfocarlo cuando se vuelva a analizar. */
  select?: { line: number }
}

const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')

/** Dónde acaba la línea que contiene `at` (antes del salto de línea). */
function lineEnd(text: string, at: number): number {
  const i = text.indexOf('\n', at)
  if (i < 0) return text.length
  return text[i - 1] === '\r' ? i - 1 : i
}

/** Dónde empieza la línea que contiene `at`. */
const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1

/** El número de línea (base 1) de un desplazamiento. */
const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length

const blankBefore = (text: string, from: number, to: number) =>
  /^[ \t]*$/.test(text.slice(from, to))

const nodeById = (program: Program, id: string): ProgramNode | undefined =>
  program.nodes.find((n) => n.id === id)

/** Reescribe la sentencia (o su cabecera, si es compuesta) con el texto que se escribió. */
export function replaceCode(program: Program, id: string, text: string): Change {
  const range = nodeById(program, id)?.range
  if (!range) return { edits: [] }
  if (text === program.source.slice(range.start, range.head ?? range.end)) return { edits: [] }
  return { edits: [{ start: range.start, end: range.head ?? range.end, text }] }
}

/**
 * Elimina la sentencia entera —con su cuerpo, la línea que ocupa y los comentarios que lleva
 * pegados encima—. Si era lo único que había en su bloque, lo deja con un `pass`: un bloque
 * vacío no es Python válido.
 */
export function deleteNode(program: Program, id: string): Change {
  const range = nodeById(program, id)?.range
  if (!range) return { edits: [] }
  const text = program.source
  const first = range.lead ?? range.start
  const begin = lineStart(text, first)
  const emptied = range.block <= 1 && range.owner !== undefined

  // Solo se lleva la línea entera si la sentencia la empieza: `if x: y = 1` no es una línea suya.
  if (!blankBefore(text, begin, first)) {
    return { edits: [{ start: range.start, end: range.end, text: emptied ? 'pass' : '' }] }
  }
  const eol = lineEnd(text, range.end)
  if (emptied) {
    return { edits: [{ start: begin, end: eol, text: `${' '.repeat(range.indent)}pass` }] }
  }
  const newline = text.startsWith('\r\n', eol) ? 2 : text[eol] === '\n' ? 1 : 0
  return { edits: [{ start: begin, end: eol + newline, text: '' }] }
}

/** Pone una copia de la sentencia justo debajo de ella. */
export function duplicateNode(program: Program, id: string): Change {
  const range = nodeById(program, id)?.range
  if (!range) return { edits: [] }
  const text = program.source
  const begin = lineStart(text, range.start)
  const eol = lineEnd(text, range.end)
  const copy = text.slice(blankBefore(text, begin, range.start) ? begin : range.start, eol)
  return {
    edits: [{ start: eol, end: eol, text: `${eolOf(text)}${copy}` }],
    select: { line: lineOf(text, eol) + 1 },
  }
}

/** Las líneas de cada plantilla. Es el Python que aparece al añadir un nodo. */
const LINES: Record<TemplateId, string[]> = {
  variable: ['variable = 0'],
  text: ['texto = "hola"'],
  boolean: ['activo = True'],
  list: ['lista = [1, 2, 3]'],
  dict: ['datos = {"clave": "valor"}'],
  operation: ['resultado = 1 + 2'],
  call: ['resultado = funcion(valor)'],
  input: ['dato = input("Escribe algo: ")'],
  print: ['print("Hola")'],
  if: ['if valor > 0:', '    pass'],
  ifelse: ['if valor > 0:', '    pass', 'else:', '    pass'],
  for: ['for elemento in range(10):', '    pass'],
  while: ['while valor > 0:', '    pass'],
  return: ['return valor'],
  raise: ['raise ValueError("mensaje")'],
  import: ['import modulo'],
  function: ['def nueva_funcion():', '    pass'],
}

/** Una función se separa de lo de alrededor con dos líneas en blanco, como pide PEP 8. */
const SPACED: ReadonlySet<TemplateId> = new Set(['function'])

/**
 * Añade una plantilla: detrás de un nodo (con su misma sangría), al final del cuerpo de una
 * función (`into`), o al final del archivo si no se dice dónde.
 */
export function addTemplate(
  program: Program,
  template: TemplateId,
  where: { after?: string; into?: string } = {},
): Change {
  const text = program.source
  const eol = eolOf(text)
  let at: number
  let indent = 0
  let prefix = ''

  const anchor = where.after ? nodeById(program, where.after) : undefined
  const scope = where.into ? nodeById(program, where.into) : undefined
  if (anchor?.range) {
    at = lineEnd(text, anchor.range.end)
    indent = anchor.range.indent
  } else if (scope?.range) {
    at = lineEnd(text, scope.range.bodyEnd ?? scope.range.end)
    indent = scope.range.bodyIndent ?? scope.range.indent + 4
  } else {
    // Al final del archivo. Si no acaba en salto de línea, se pone uno antes.
    at = text.length
    if (text.length > 0 && !text.endsWith('\n')) prefix = eol
  }

  const atEndOfFile = at === text.length && !anchor?.range && !scope?.range
  const blanks = SPACED.has(template) && text.trim() !== '' ? [eol, eol] : []
  const lines = LINES[template].map((line) => ' '.repeat(indent) + line).join(eol)
  // Detrás de una línea, se empieza con un salto; al final del archivo, se cierra con él.
  const body = atEndOfFile
    ? `${prefix}${blanks.join('')}${lines}${eol}`
    : `${eol}${blanks.join('')}${lines}`
  const breaks = (body.slice(0, body.indexOf(lines)).match(/\n/g) ?? []).length
  return {
    edits: [{ start: at, end: at, text: body }],
    select: { line: lineOf(text, at) + breaks },
  }
}

/** Cambia el nombre de lo que define un nodo (una variable, una función), en todos sus usos. */
export function renameNode(program: Program, id: string, to: string): Change {
  const node = nodeById(program, id)
  return { edits: node ? renameEdits(node, node.label, to) : [] }
}

/** Convierte lo que el usuario hizo en un nodo o en el menú de añadir en ediciones de texto. */
export function actionEdits(program: Program, action: NodeAction): Change {
  switch (action.type) {
    case 'code':
      return replaceCode(program, action.id, action.text)
    case 'delete':
      return deleteNode(program, action.id)
    case 'duplicate':
      return duplicateNode(program, action.id)
    case 'rename':
      return renameNode(program, action.id, action.to)
    case 'add':
      return addTemplate(program, action.template, {
        ...(action.after === undefined ? {} : { after: action.after }),
        ...(action.into === undefined ? {} : { into: action.into }),
      })
  }
}
