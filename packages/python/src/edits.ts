import { isConstantExpression } from '@prysel/morphology'
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
  const step = /^steps\[(\d+)\]\.(name|args)$/.exec(path)
  if (step && model.kind === 'chain')
    return model.steps[Number(step[1])]?.[step[2] as 'name' | 'args']
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
    case 'arguments': {
      // Los argumentos de un paso pueden quedar vacíos (`.sum()`), pero no ocupar varias líneas.
      const text = String(value).trim()
      return /[\r\n]/.test(text) ? null : text
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

/** Una cadena de pasos escrita de nuevo en una línea, o `null` si algo de ella no se puede escribir. */
export function chainText(model: Extract<ControlModel, { kind: 'chain' }>): string | null {
  const multiline = (text: string) => /[\r\n]/.test(text)
  const receiver = model.receiver.trim()
  if (receiver === '' || multiline(receiver) || model.steps.length === 0) return null
  let text = receiver
  for (const step of model.steps) {
    const args = step.args.trim()
    if (multiline(args)) return null
    if (step.kind === 'index') {
      if (args === '') return null
      text += `[${args}]`
    } else {
      if (!isIdentifier(step.name.trim())) return null
      text += `.${step.name.trim()}${step.kind === 'call' ? `(${args})` : ''}`
    }
  }
  return text
}

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
  // Quitar, añadir o cambiar de tipo un paso de una cadena reescribe la cadena entera; cambiar el texto
  // de los pasos que hay (también intercambiar dos del mismo tipo) reescribe cada trozo en su sitio.
  if (control.kind === 'chain' && next.kind === 'chain') {
    const same =
      control.steps.length === next.steps.length &&
      control.steps.every((step, i) => step.kind === next.steps[i]?.kind)
    if (!same) {
      const whole = sources?.['chain']
      const text = chainText(next)
      return whole && text !== null ? [{ start: whole.start, end: whole.end, text }] : []
    }
  }
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

/**
 * Las ediciones que deshacen `edits` aplicadas sobre `before`: sobre el texto que resulta de ellas,
 * devuelven cada trozo a lo que era. Es lo que guarda el «deshacer» del lienzo: aplicar unas y luego sus
 * inversas deja el texto exactamente como estaba.
 */
export function invertEdits(before: string, edits: readonly TextEdit[]): TextEdit[] {
  let shift = 0
  return [...edits]
    .sort((a, b) => a.start - b.start)
    .map((edit) => {
      const start = edit.start + shift
      shift += edit.text.length - (edit.end - edit.start)
      return { start, end: start + edit.text.length, text: before.slice(edit.start, edit.end) }
    })
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

/**
 * Las líneas de cada plantilla. Es el Python que aparece al añadir un nodo. Con `fill` (el nombre
 * de una variable que llega por un cable), el primer campo que admite un valor lo lee de ella.
 */
function linesOf(template: TemplateId, fill?: string): string[] {
  switch (template) {
    case 'variable':
      return [`variable = ${fill ?? '0'}`]
    case 'text':
      return ['texto = "hola"']
    case 'boolean':
      return ['activo = True']
    case 'list':
      return [`lista = [${fill ?? '1, 2, 3'}]`]
    case 'dict':
      return ['datos = {"clave": "valor"}']
    case 'operation':
      return [`resultado = ${fill ?? '1'} + 2`]
    case 'call':
      return [`resultado = funcion(${fill ?? 'valor'})`]
    case 'input':
      return ['dato = input("Escribe algo: ")']
    case 'print':
      return [fill ? `print(${fill})` : 'print("Hola")']
    case 'if':
      return [`if ${fill ?? 'valor'} > 0:`, '    pass']
    case 'ifelse':
      return [`if ${fill ?? 'valor'} > 0:`, '    pass', 'else:', '    pass']
    case 'for':
      return [`for elemento in ${fill ?? 'range(10)'}:`, '    pass']
    case 'while':
      return [`while ${fill ?? 'valor'} > 0:`, '    pass']
    case 'break':
      return ['break']
    case 'continue':
      return ['continue']
    case 'try':
      return ['try:', '    pass', 'except Exception as error:', '    pass']
    case 'with':
      return ['with open("archivo.txt") as archivo:', '    pass']
    case 'return':
      return [`return ${fill ?? 'valor'}`]
    case 'raise':
      return ['raise ValueError("mensaje")']
    case 'import':
      return ['import modulo']
    // Con dos parámetros y algo que hacer con ellos, para que se vean sus puertos y sus cables.
    case 'function':
      return ['def nueva_funcion(a, b):', '    return a + b']
  }
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
  where: Place & { fill?: string } = {},
): Change {
  return insertLines(
    program,
    where,
    (indent) => linesOf(template, where.fill).map((line) => ' '.repeat(indent) + line),
    SPACED.has(template),
  )
}

/**
 * Escribe unas líneas en un sitio del programa: detrás de un nodo (con su misma sangría), al final
 * del cuerpo de una función o un bucle (`into`), o al final del archivo. `lines` recibe la sangría
 * del sitio y devuelve las líneas ya sangradas. Un cuerpo que era solo `pass` se sustituye.
 */
/** Un camino de una decisión, descrito como el cuerpo de una sentencia compuesta. */
interface Region {
  head: number
  bodyEnd: number
  end: number
  indent: number
  bodyIndent?: number
}

/** Dónde se escribe algo: detrás o justo antes de un nodo, al final de un cuerpo, o en un camino de una decisión. */
interface Place {
  after?: string
  into?: string
  before?: string
  /** El cuerpo de un camino de una decisión (para sustituir su pass). */
  region?: Region
  /** Hay que crear el else de esta decisión. */
  elseOf?: string
}

function insertLines(
  program: Program,
  where: Place,
  lines: (indent: number) => string[],
  spaced = false,
): Change {
  const text = program.source
  const eol = eolOf(text)
  let at: number
  let indent = 0
  let prefix = ''
  /** Un cuerpo que era solo `pass` no se deja colgando: lo nuevo lo sustituye. */
  let pass: { start: number; end: number } | undefined

  const anchor = where.after ? nodeById(program, where.after) : undefined
  const scope = where.into ? nodeById(program, where.into) : undefined
  const before = where.before ? nodeById(program, where.before) : undefined
  const region = where.region
  const decision = where.elseOf ? nodeById(program, where.elseOf) : undefined
  /** Se escribe al principio del archivo: no hay línea anterior a la que pegarse. */
  let leading = false
  if (before?.range) {
    // Justo antes de una sentencia (y de los comentarios que lleva pegados): al final de la línea anterior.
    const first = lineStart(text, before.range.lead ?? before.range.start)
    indent = before.range.indent
    if (first === 0) {
      at = 0
      leading = true
    } else at = first - (text.slice(first - 2, first) === '\r\n' ? 2 : 1)
  } else if (anchor?.range) {
    at = lineEnd(text, anchor.range.end)
    indent = anchor.range.indent
  } else if (decision?.range) {
    // Una decisión sin else: se crea al final, con lo que se mueva dentro.
    at = lineEnd(text, decision.range.end)
    indent = decision.range.bodyIndent ?? decision.range.indent + 4
  } else if (region ?? scope?.range) {
    const box = (region ?? scope?.range) as Region
    at = lineEnd(text, box.bodyEnd ?? box.end)
    indent = box.bodyIndent ?? box.indent + 4
    const { head, bodyEnd } = box
    if (head !== undefined && bodyEnd !== undefined) {
      const body = text.slice(head, bodyEnd)
      if (/^\s*pass\s*$/.test(body)) {
        const start = head + body.indexOf('pass')
        pass = { start, end: start + 4 }
      }
    }
    // Lo que se mete en una función o un bucle va **antes** de su `return`, `break` o `continue`
    // final: detrás nunca se ejecutaría.
    const end = lineEnd(text, box.bodyEnd ?? box.end)
    const closing =
      region || !scope
        ? undefined
        : program.nodes.find(
            (n) =>
              (n.kind === 'control.return' ||
                n.kind === 'control.break' ||
                n.kind === 'control.continue') &&
              n.range?.owner === scope.id &&
              lineEnd(text, n.range.end) === end,
          )
    if (!pass && closing?.range) {
      const first = lineStart(text, closing.range.lead ?? closing.range.start)
      // Justo después de la línea anterior (la del `def`, si el `return` es lo primero).
      at = first - (text.slice(first - 2, first) === '\r\n' ? 2 : 1)
      indent = closing.range.indent
    }
  } else {
    // Al final del archivo. Si no acaba en salto de línea, se pone uno antes.
    at = text.length
    if (text.length > 0 && !text.endsWith('\n')) prefix = eol
  }

  const written = decision?.range
    ? [' '.repeat(decision.range.indent) + 'else:', ...lines(indent)]
    : lines(indent)
  if (pass) {
    // El primer renglón ocupa el sitio del `pass` (que ya lleva su sangría); el resto va debajo.
    const joined = written.map((line, i) => (i === 0 ? line.trimStart() : line)).join(eol)
    return {
      edits: [{ start: pass.start, end: pass.end, text: joined }],
      select: { line: lineOf(text, pass.start) },
    }
  }

  const atEndOfFile =
    at === text.length &&
    !anchor?.range &&
    !scope?.range &&
    !before?.range &&
    !region &&
    !decision?.range
  const blanks = spaced && text.trim() !== '' ? [eol, eol] : []
  const block = written.join(eol)
  // Detrás de una línea, se empieza con un salto; al final del archivo, se cierra con él.
  const body = leading
    ? `${block}${eol}`
    : atEndOfFile
      ? `${prefix}${blanks.join('')}${block}${eol}`
      : `${eol}${blanks.join('')}${block}`
  const breaks = (body.slice(0, body.indexOf(block)).match(/\n/g) ?? []).length
  return {
    edits: [{ start: at, end: at, text: body }],
    select: { line: lineOf(text, at) + breaks },
  }
}

const newlines = (text: string) => (text.match(/\n/g) ?? []).length

/** Cambia la sangría de un bloque de líneas de `from` a `to` columnas (las líneas en blanco no se tocan). */
function reindent(block: string[], from: number, to: number): string[] {
  const delta = to - from
  if (delta === 0) return block
  return block.map((line) => {
    if (line.trim() === '') return line
    return delta > 0 ? ' '.repeat(delta) + line : line.replace(new RegExp(`^ {0,${-delta}}`), '')
  })
}

/**
 * Mueve una sentencia entera —con su cuerpo y los comentarios que lleva pegados— al final del
 * cuerpo de una función (`into`) o detrás de otro nodo (`after`), cambiándole la sangría al nuevo
 * sitio. Es lo que escribe arrastrar un nodo dentro o fuera de una función. Si la sentencia era lo
 * único de su bloque, ese queda con un `pass`. No mueve algo dentro de sí mismo.
 */
export function moveNode(
  program: Program,
  id: string,
  request: {
    after?: string
    into?: string
    before?: string
    start?: boolean
    branch?: 'yes' | 'no'
  },
): Change {
  const node = nodeById(program, id)
  const range = node?.range
  const where = resolvePlace(program, request)
  if (!where) return { edits: [] }
  const target = nodeById(program, where.after ?? where.into ?? where.before ?? where.elseOf ?? '')
  // Una cláusula (except, else, finally) no es una sentencia suelta: ni se mueve, ni se pone algo «detrás» de ella.
  if (node && CLAUSE_KINDS.has(node.kind)) return { edits: [] }
  if (target && CLAUSE_KINDS.has(target.kind) && where.into === undefined) return { edits: [] }
  if (!node || !range || !target?.range || target.id === id) return { edits: [] }
  // Ni dentro de sí misma, ni detrás de algo que ella contiene.
  if (target.range.start >= range.start && target.range.end <= range.end) return { edits: [] }

  const text = program.source
  const first = range.lead ?? range.start
  const begin = lineStart(text, first)
  // Una sentencia que comparte línea con otra (`if x: y = 1`) no es una línea suya: no se mueve.
  if (!blankBefore(text, begin, first)) return { edits: [] }
  const block = text.slice(begin, lineEnd(text, range.end)).split(/\r?\n/)

  let removed = deleteNode(program, id).edits
  if (removed.length === 0) return { edits: [] }
  const placed = insertLines(program, where, (indent) => reindent(block, range.indent, indent))
  const insertion = placed.edits[0]
  if (!insertion) return { edits: [] }
  let edits = [...removed, ...placed.edits]
  if (!validEdits(edits, text.length)) {
    // Sacar lo último de una función y ponerlo detrás de ella: el sitio de destino es justo el final
    // de lo que se quita. Se lleva el salto de línea de antes en vez del de después, y las dos
    // ediciones quedan pegadas en lugar de solaparse.
    const cut = removed[0]
    const before = text.slice(begin - 2, begin) === '\r\n' ? 2 : text[begin - 1] === '\n' ? 1 : 0
    if (removed.length !== 1 || cut?.text !== '' || before === 0) return { edits: [] }
    removed = [{ start: begin - before, end: lineEnd(text, range.end), text: '' }]
    edits = [...removed, ...placed.edits]
    if (!validEdits(edits, text.length)) return { edits: [] }
  }

  // Lo borrado antes del sitio donde se escribe le quita líneas a la posición final.
  let shift = 0
  for (const edit of removed) {
    if (edit.end <= insertion.start) {
      shift += newlines(text.slice(edit.start, edit.end)) - newlines(edit.text)
    }
  }
  return { edits, ...(placed.select ? { select: { line: placed.select.line - shift } } : {}) }
}

/**
 * Lo que inicializa un contexto sin actuar: los valores, las colecciones, los import y las funciones
 * definidas. Lo que se mete «al principio» de un cuerpo va después de eso, para no deshacer sus chips.
 */
const SETUP: ReadonlySet<string> = new Set([
  'value.number',
  'value.str',
  'value.bool',
  'value.none',
  'data.list',
  'data.dict',
  'external.import',
  'abstraction.collapsed',
  'abstraction.class',
])

/** Las cláusulas de un try: viven dentro de él, con su propio cuerpo. */
const CLAUSE_KINDS: ReadonlySet<string> = new Set([
  'control.except',
  'control.clause',
  'control.case',
])

/** El cuerpo de un camino de una decisión, con la sangría de lo que ya lleva dentro. */
function regionOf(head: number, end: number, indent: number, bodyIndent?: number): Region {
  return { head, bodyEnd: end, end, indent, ...(bodyIndent === undefined ? {} : { bodyIndent }) }
}

/**
 * De lo que pide el usuario a un sitio concreto del texto. start es el principio de lo que actúa en
 * un cuerpo; branch es uno de los dos caminos de una decisión (se crea el else si hace falta).
 */
function resolvePlace(
  program: Program,
  request: {
    after?: string
    into?: string
    before?: string
    start?: boolean
    branch?: 'yes' | 'no'
  },
): Place | null {
  const { after, into, before, start, branch } = request
  const inside = (owner: string) =>
    program.nodes
      // Las cláusulas de un try cuelgan de él, pero no son sentencias de su cuerpo.
      .filter((n) => n.range?.owner === owner && !CLAUSE_KINDS.has(n.kind))
      .sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0))
  // El cuerpo de un `match` solo admite casos: una sentencia suelta ahí dentro no sería Python. Lo que
  // se quiera meter va dentro de uno de sus casos.
  if (into !== undefined && nodeById(program, into)?.kind === 'control.match') return null
  if (into !== undefined && branch !== undefined) {
    const decision = nodeById(program, into)
    const r = decision?.range
    // Un bucle solo tiene el camino de su `else` (lo que se hace al acabar sin salir): al principio de él,
    // y si no lo tiene, se crea. Su `else` es una cláusula aparte (va detrás del bucle), con su cuerpo.
    if (decision?.kind === 'control.loop' && r && branch === 'no') {
      const { elseAt } = r
      if (elseAt === undefined) return { elseOf: decision.id }
      const clause = program.nodes.find(
        (n) => n.kind === 'control.clause' && n.range?.start === elseAt,
      )
      if (!clause) return null
      const first = inside(clause.id)[0]
      return first ? { before: first.id } : { into: clause.id }
    }
    if (!decision || decision.kind !== 'control.condition' || !r) return null
    // Su camino falso sigue en un `elif`: lo que vaya ahí entra por los puertos de ese `elif`.
    if (branch === 'no' && decision.continues !== undefined) return null
    const { head, yesEnd } = r
    if (head === undefined || yesEnd === undefined) return null
    const nodes = inside(decision.id)
    if (branch === 'yes') {
      const first = nodes.find((n) => n.range && n.range.start > head && n.range.end <= yesEnd)
      return first
        ? { before: first.id }
        : { into: decision.id, region: regionOf(head, yesEnd, r.indent, r.bodyIndent) }
    }
    const { elseAt, elseHead, elseEnd } = r
    if (elseAt === undefined || elseHead === undefined || elseEnd === undefined) {
      return { elseOf: decision.id }
    }
    const first = nodes.find((n) => n.range && n.range.start >= elseHead)
    return first
      ? { before: first.id }
      : { into: decision.id, region: regionOf(elseHead, elseEnd, r.indent, r.bodyIndent) }
  }
  if (into !== undefined && start) {
    const first = inside(into).find(
      (n) =>
        !SETUP.has(n.kind) &&
        !(n.kind === 'transform.operation' && isConstantExpression(n.control)),
    )
    return first ? { before: first.id } : { into }
  }
  return {
    ...(after === undefined ? {} : { after }),
    ...(into === undefined ? {} : { into }),
    ...(before === undefined ? {} : { before }),
  }
}

/**
 * La primera sentencia de un contexto (el cuerpo de una función o de un bucle, o el archivo si no se
 * dice cuál): ahí se inicializan las variables. En el archivo se salta los `import`, que van antes.
 */
function firstStatement(program: Program, into?: string): ProgramNode | undefined {
  return program.nodes
    .filter((n) => n.range?.owner === into && (into !== undefined || n.kind !== 'external.import'))
    .sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0))[0]
}

/** El nombre que sale por un puerto de un nodo: el del parámetro, o el que el nodo define. */
function outputName(source: ProgramNode, port?: string): string | undefined {
  if (port?.startsWith('param:')) {
    const name = port.slice('param:'.length)
    return source.params?.includes(name) ? name : undefined
  }
  if (port?.startsWith('result:')) {
    const name = port.slice('result:'.length)
    return source.results?.includes(name) ? name : undefined
  }
  return source.provides
}

/**
 * Conecta la salida de un nodo con un campo de otro: el campo pasa a leer el nombre que el origen
 * define. Solo si ese nombre está al alcance del destino (definido antes, y en su ámbito): un cable
 * que escribiera un nombre que Python no conoce en ese punto rompería el programa.
 */
export function connectNodes(
  program: Program,
  action: { from: string; to: string; slot: string; port?: string; convert?: 'float' },
): Change {
  const source = nodeById(program, action.from)
  const target = nodeById(program, action.to)
  if (action.slot === 'return' && target?.kind === 'abstraction.collapsed') {
    return connectReturn(program, target, source, action.port)
  }
  // Un chip de función soltado sobre la casilla de una llamada: pasa a llamar a esa función.
  if (action.slot === 'callee') {
    // Solo una función se puede llamar: una variable no se escribe donde va a quién se llama.
    const name =
      source?.kind === 'abstraction.collapsed' && !action.port ? source.provides : undefined
    return target && name && target.scope?.includes(name)
      ? changeCallee(program, target.id, name)
      : { edits: [] }
  }
  const at = target?.inputs?.[action.slot]
  const name = source ? outputName(source, action.port) : undefined
  if (!source || !target || !at || !name || !isIdentifier(name) || source.id === target.id) {
    return { edits: [] }
  }
  if (!target.scope?.includes(name)) return { edits: [] }
  const written = action.convert === 'float' ? `float(${name})` : name
  if (program.source.slice(at.start, at.end) === written) return { edits: [] }
  return { edits: [{ start: at.start, end: at.end, text: written }] }
}

/**
 * Conecta algo al puerto de retorno de una función: la función pasa a devolver ese valor. Si ya
 * tiene un `return` en su cuerpo, cambia lo que devuelve; si no, lo añade al final.
 */
function connectReturn(
  program: Program,
  def: ProgramNode,
  source: ProgramNode | undefined,
  port?: string,
): Change {
  const name = source ? outputName(source, port) : undefined
  if (!source || !name || !isIdentifier(name)) return { edits: [] }
  const inside =
    def.contains?.includes(source.id) === true ||
    (source.id === def.id && port?.startsWith('param:') === true)
  if (!inside) return { edits: [] }

  const returns = program.nodes
    .filter((n) => n.kind === 'control.return' && n.range?.owner === def.id)
    .sort((a, b) => a.line - b.line)
  const last = returns[returns.length - 1]
  if (!last?.range) return addTemplate(program, 'return', { into: def.id, fill: name })

  const value = last.inputs?.['arg:valor']
  if (value) {
    if (program.source.slice(value.start, value.end) === name) return { edits: [] }
    return { edits: [{ start: value.start, end: value.end, text: name }] }
  }
  // Un `return a + b` (o algo que no es un valor suelto) se sustituye entero.
  return { edits: [{ start: last.range.start, end: last.range.end, text: `return ${name}` }] }
}

/** Un nombre que se puede llamar: un identificador, con puntos si es un método (`df.head`). */
const CALLEE = /^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u

/**
 * Cambia a quién llama una llamada. Si la nueva función es del programa, la lista de argumentos se
 * ajusta a sus parámetros (los valores que ya había se conservan, por posición; los que faltan
 * quedan en `None`) para que cada parámetro tenga su casilla. Y si devuelve algo y la llamada estaba
 * suelta (`f(x)`), su resultado se guarda en una variable, que es la salida del nodo.
 */
export function changeCallee(program: Program, id: string, callee: string): Change {
  const node = nodeById(program, id)
  const target = node?.sources?.['target']
  const list = node?.sources?.['argsList']
  const control = node?.control
  if (!node || !target || !list || control?.kind !== 'args' || !CALLEE.test(callee)) {
    return { edits: [] }
  }
  if (callee === control.target) return { edits: [] }
  const text = program.source

  const def = program.nodes.find((n) => n.kind === 'abstraction.collapsed' && n.provides === callee)
  const edits: TextEdit[] = []

  // Suelta y con resultado: se guarda. El nombre no puede chocar con nada de lo que el nodo ve.
  const returns =
    def !== undefined &&
    program.nodes.some((n) => n.kind === 'control.return' && def.contains?.includes(n.id))
  const bare = node.id.startsWith('expr:') && node.range !== undefined
  let head = ''
  if (returns && bare && node.range && node.range.start === target.start) {
    const taken = new Set(node.scope ?? [])
    let name = 'resultado'
    for (let n = 2; taken.has(name); n++) name = `resultado_${n}`
    head = `${name} = `
  }
  edits.push({ start: target.start, end: target.end, text: `${head}${callee}` })

  if (def) {
    const params = def.params ?? []
    const current = control.args.map((arg) => arg.value)
    const next = params.map((_, i) => current[i]?.trim() || 'None')
    if (text.slice(list.start, list.end) !== next.join(', ')) {
      edits.push({ start: list.start, end: list.end, text: next.join(', ') })
    }
  }
  return { edits }
}

/**
 * Mueve un extremo de un cable ya tendido. El cable nuevo se escribe igual que al conectar
 * (`connectNodes`, con sus mismas comprobaciones de alcance); si cambió el destino, el campo que
 * alimentaba antes vuelve a un valor neutro en la misma edición. Si el cable nuevo no vale, no hay
 * edición: el de antes se queda donde estaba, en vez de quedar suelto.
 */
export function reconnectNodes(
  program: Program,
  action: {
    was: { id: string; slot: string }
    from: string
    port?: string
    to: string
    slot: string
    convert?: 'float'
  },
): Change {
  const moved = action.was.id !== action.to || action.was.slot !== action.slot
  const connected = connectNodes(program, action)
  if (connected.edits.length === 0) {
    // Mismo destino y mismo nombre (se soltó donde estaba): nada que hacer. Otro destino que no vale: tampoco.
    return { edits: [] }
  }
  if (!moved) return connected
  const released = disconnectNode(program, action.was.id, action.was.slot)
  return { edits: [...released.edits, ...connected.edits].sort((a, b) => a.start - b.start) }
}

/** Suelta el cable de un campo: vuelve a un valor neutro que Python acepta. */
export function disconnectNode(program: Program, id: string, slot: string): Change {
  const at = nodeById(program, id)?.inputs?.[slot]
  if (!at) return { edits: [] }
  const neutral =
    at.as === 'string' ? '""' : slot === 'iterable' ? '[]' : slot.startsWith('arg:') ? 'None' : '0'
  return { edits: [{ start: at.start, end: at.end, text: neutral }] }
}

/** Cambia el nombre de lo que define un nodo (una variable, una función), en todos sus usos. */
export function renameNode(program: Program, id: string, to: string, from?: string): Change {
  const node = nodeById(program, id)
  // Con varios nombres (`a, b = f()`), la acción dice cuál; sin ella, el del nodo.
  const current = from !== undefined && node?.results?.includes(from) ? from : node?.label
  return { edits: node && current !== undefined ? renameEdits(node, current, to) : [] }
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
      return renameNode(program, action.id, action.to, action.from)
    case 'add': {
      // Dentro de un `match` solo caben casos (ver `resolvePlace`).
      if (action.into !== undefined && nodeById(program, action.into)?.kind === 'control.match') {
        return { edits: [] }
      }
      const source = action.connect ? nodeById(program, action.connect.from) : undefined
      const fill = source && action.connect ? outputName(source, action.connect.port) : undefined
      // Al principio de un cuerpo o de un camino de una decisión (donde llevan los puertos de orden).
      const placed =
        action.branch !== undefined || action.start
          ? resolvePlace(program, {
              ...(action.into === undefined ? {} : { into: action.into }),
              ...(action.start ? { start: true } : {}),
              ...(action.branch === undefined ? {} : { branch: action.branch }),
            })
          : undefined
      if (placed === null) return { edits: [] }
      if (placed) {
        return addTemplate(program, action.template, {
          ...placed,
          ...(fill === undefined || !isIdentifier(fill) ? {} : { fill }),
        })
      }
      const first = action.at === 'start' ? firstStatement(program, action.into) : undefined
      return addTemplate(program, action.template, {
        ...(action.after === undefined ? {} : { after: action.after }),
        // Al principio del contexto: antes de su primera sentencia. Si no tiene ninguna, es el final.
        ...(first === undefined
          ? action.into === undefined
            ? {}
            : { into: action.into }
          : { before: first.id }),
        ...(fill === undefined || !isIdentifier(fill) ? {} : { fill }),
      })
    }
    case 'move':
      return moveNode(program, action.id, {
        ...(action.after === undefined ? {} : { after: action.after }),
        ...(action.into === undefined ? {} : { into: action.into }),
        ...(action.before === undefined ? {} : { before: action.before }),
        ...(action.start === undefined ? {} : { start: action.start }),
        ...(action.branch === undefined ? {} : { branch: action.branch }),
      })
    case 'callee':
      return changeCallee(program, action.id, action.callee)
    case 'connect':
      return connectNodes(program, action)
    case 'disconnect':
      return disconnectNode(program, action.id, action.slot)
    case 'reconnect':
      return reconnectNodes(program, action)
  }
}
