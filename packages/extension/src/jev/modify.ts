import type { Program, ProgramNode } from '@prysel/python'
import { addCode, deleteNode, replaceCode, type Change } from '@prysel/python/edits'

/**
 * Cambiar lo que **ya está escrito**: «ahora que reste en lugar de sumar», «refactoriza esto», «quita el
 * aviso». No se reescribe el programa: la IA generativa dicta, en streaming, una lista de cambios pequeños
 * —cambiar una sentencia, quitarla, añadir algo junto a otra— que nombran las sentencias por su **número
 * de línea** (el código se le pasa numerado). Cada cambio se juzga, se escribe y se ve por separado, con
 * su animación y su frase: se ve *qué* cambió, no solo que algo es distinto.
 *
 * Los números de línea que da el modelo son los del programa **de antes de empezar**. Como cada cambio
 * mueve lo que hay debajo, `LineMap` lleva la cuenta: traduce una línea de antes a donde está ahora.
 */

export type ChangeOp =
  /** La sentencia que empieza en esa línea pasa a ser `code` (de una compuesta, solo su cabecera: su cuerpo se queda). */
  | { op: 'change'; line: number; code: string; say: string }
  /** Se quita la sentencia que empieza en esa línea (con su cuerpo, si es compuesta). */
  | { op: 'remove'; line: number; say: string }
  /** Se añade `code` (una o varias sentencias completas) detrás de la sentencia de esa línea, o dentro de ella. */
  | { op: 'add'; line: number; inside: boolean; code: string; say: string }

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** Quita la sangría que comparten todas las líneas de un trozo de código: la deja pegada al margen. */
export function dedent(code: string): string {
  const rows = code.split('\n')
  const depth = Math.min(
    ...rows.filter((row) => row.trim() !== '').map((row) => row.length - row.trimStart().length),
  )
  return Number.isFinite(depth) && depth > 0
    ? rows.map((row) => (row.trim() === '' ? '' : row.slice(depth))).join('\n')
    : code
}

/**
 * Si la sangría de un programa tiene sentido: ninguna línea va más metida que la anterior sin que esta
 * abra un bloque (acabe en dos puntos). El analizador tolera eso sin quejarse, y Python no: es lo que
 * delata un cambio mal colocado. No mira dentro de textos de varias líneas ni de paréntesis abiertos.
 */
export function indentationOk(source: string): boolean {
  const QUOTES = '"'.repeat(3)
  const TICKS = "'".repeat(3)
  let depth = 0
  let triple: string | null = null
  let continued = false
  let previous: { indent: number; opens: boolean } | null = null
  for (const raw of source.split(/\r?\n/)) {
    const inside = depth > 0 || triple !== null || continued
    let code = ''
    for (let i = 0; i < raw.length; i++) {
      const three = raw.slice(i, i + 3)
      if (triple !== null) {
        if (three === triple) {
          triple = null
          i += 2
        }
        continue
      }
      const char = raw[i] ?? ''
      if (three === QUOTES || three === TICKS) {
        triple = three
        i += 2
        continue
      }
      if (char === '"' || char === "'") {
        // Un texto de una línea: hasta su cierre (o el final de la línea).
        let end = i + 1
        while (end < raw.length && raw[end] !== char) end += raw[end] === '\\' ? 2 : 1
        i = end
        code += '""'
        continue
      }
      if (char === '#') break
      if ('([{'.includes(char)) depth++
      else if (')]}'.includes(char)) depth = Math.max(0, depth - 1)
      code += char
    }
    const written = code.trim()
    continued = written.endsWith('\\')
    const closed = depth === 0 && triple === null && !continued
    if (inside) {
      // Una línea de continuación: lo que cuenta es cómo acaba la sentencia entera.
      if (previous && closed) previous.opens = written.endsWith(':')
      continue
    }
    if (written === '') continue
    const indent = raw.length - raw.trimStart().length
    if (previous ? indent > previous.indent && !previous.opens : indent > 0) return false
    previous = { indent, opens: closed && written.endsWith(':') }
  }
  return true
}

/** Un tramo que cambia entre dos versiones de un programa: dónde queda en la nueva y cuántas líneas trae. */
export interface Hunk {
  /** La línea donde queda en la versión nueva (desde 1). */
  line: number
  /** Cuántas líneas pone (0: solo quita). */
  added: number
  /** Cuántas quita de la versión anterior. */
  removed: number
}

/** Un trozo del programa a la altura del archivo: una función, una clase, una asignación, un bucle… */
export interface TopBlock {
  /** Lo que lo identifica: `def nombre`, `class Nombre`, `nombre =`, o su primera línea. */
  key: string
  /** Su primera línea de código, para nombrarlo. */
  head: string
  /** Su texto entero, con los comentarios que lleva encima. */
  text: string
}

/**
 * Los trozos de un programa a la altura del archivo, en orden. Los comentarios y decoradores de justo encima
 * van con el trozo que encabezan; lo que continúa uno (`else:`, un corchete que se cierra) va con él.
 */
export function topBlocks(source: string): TopBlock[] {
  const rows = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: { lead: string[]; body: string[] }[] = []
  let lead: string[] = []
  let open: { lead: string[]; body: string[] } | null = null
  for (const row of rows) {
    const flush = /^\S/.test(row)
    if (!flush) {
      // Una línea en blanco o sangrada: del trozo abierto, o de lo que encabeza al siguiente.
      if (open && lead.length === 0) open.body.push(row)
      else lead.push(row)
      continue
    }
    if (/^(#|@)/.test(row)) {
      lead.push(row)
      continue
    }
    if (open && /^(else\b|elif\b|except\b|finally\b|[\])}])/.test(row)) {
      open.body.push(...lead, row)
      lead = []
      continue
    }
    open = { lead, body: [row] }
    blocks.push(open)
    lead = []
  }
  return blocks.map((block) => {
    const head = block.body[0] ?? ''
    const named =
      /^(?:async\s+)?(def|class)\s+(\w+)/.exec(head) ??
      /^()([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(head)
    const key = named ? `${named[1] ?? ''} ${named[2] ?? ''}`.trim() : head.trim()
    const text = [...block.lead, ...block.body].join('\n').replace(/^\n+|\n+$/g, '')
    return { key: named?.[1] ? key : named ? `${key} =` : key, head: head.trim(), text }
  })
}

/** Los trozos que estaban en el programa y ya no están en su versión nueva (ni cambiados: no están). */
export function lostBlocks(before: string, after: string): TopBlock[] {
  const kept = new Set(topBlocks(after).map((block) => block.key))
  return topBlocks(before).filter((block) => !kept.has(block.key))
}

/**
 * La versión nueva, con lo que se había perdido devuelto a su sitio: cada trozo que falta vuelve donde
 * estaba, entre los que sí siguen (que quedan como en la versión nueva).
 */
export function restoreLost(before: string, after: string): string {
  const fresh = topBlocks(after)
  const used = new Set<number>()
  const out: string[] = []
  for (const block of topBlocks(before)) {
    const at = fresh.findIndex(
      (candidate, index) => !used.has(index) && candidate.key === block.key,
    )
    if (at < 0) {
      out.push(block.text)
      continue
    }
    // Lo nuevo que la versión nueva puso antes de este trozo entra con él.
    for (let index = 0; index <= at; index++) {
      if (used.has(index)) continue
      used.add(index)
      out.push(fresh[index]?.text ?? '')
    }
  }
  for (const [index, block] of fresh.entries()) if (!used.has(index)) out.push(block.text)
  return `${out.filter((text) => text !== '').join('\n\n')}\n`
}

/**
 * Qué cambia entre dos versiones de un programa, línea a línea: los tramos distintos (para enseñarlos uno a
 * uno) y la edición única que lleva de una a otra (para escribirla de una vez, sin estados intermedios).
 */
export function changesBetween(
  before: string,
  after: string,
): { edit: { start: number; end: number; text: string } | null; hunks: Hunk[] } {
  const a = before.split('\n')
  const b = after.split('\n')
  // La subsecuencia común más larga, por líneas: los programas que caben aquí son pequeños.
  const common: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = common[i]
      if (!row) continue
      row[j] =
        a[i] === b[j]
          ? (common[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(common[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  let open: Hunk | null = null
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      open = null
      i++
      j++
      continue
    }
    if (!open) {
      open = { line: j + 1, added: 0, removed: 0 }
      hunks.push(open)
    }
    if (j < b.length && (i >= a.length || (common[i]?.[j + 1] ?? 0) >= (common[i + 1]?.[j] ?? 0))) {
      open.added++
      j++
    } else {
      open.removed++
      i++
    }
  }
  if (hunks.length === 0) return { edit: null, hunks }
  // La edición: de la primera línea distinta a la última, con lo que hay igual por delante y por detrás.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }
  const offset = (rows: string[], count: number) =>
    rows.slice(0, count).reduce((sum, row) => sum + row.length + 1, 0)
  const start = offset(a, head)
  const end = Math.min(before.length, offset(a, a.length - tail) - (tail === 0 ? 1 : 0))
  const text =
    b.slice(head, b.length - tail).join('\n') + (tail === 0 || head === b.length - tail ? '' : '\n')
  return { edit: { start, end: Math.max(start, end), text }, hunks }
}

/** A la IA: el programa entero, con el cambio hecho. Sin formato: código, y nada más. */
export function rewriteSystem(): string {
  return [
    'Te doy un programa en Python que ya está escrito y un cambio que alguien pide. Devuelve el programa ENTERO con ese cambio hecho.',
    'Solo el código: Python tal cual iría en el archivo, sin explicaciones ni vallas de código alrededor.',
    'Cambia lo mínimo necesario para cumplir lo que se pide, pero cúmplelo de verdad: si hace falta un dato nuevo, un método que no existe o tocar otra parte del programa para que funcione, hazlo. Todo lo demás déjalo idéntico, línea por línea, con su misma sangría y sus mismos comentarios.',
    'Los comentarios cortos que encabezan un grupo de pasos («# Aplicar la física») son los nombres de las cajas del diagrama: consérvalos, y si lo que cambias añade un grupo de pasos nuevo a un cuerpo que ya los tiene, ponle el suyo. Si se pide agrupar u ordenar por intención, eso es justo lo que hay que hacer: una línea en blanco y un comentario así delante de cada grupo, sin cambiar el código.',
    'No añadas ejemplos de uso, llamadas de prueba ni print que no se pidan. No leas ni escribas archivos, ni uses la red o el sistema, salvo que se pida expresamente.',
  ].join('\n')
}

export function rewritePrompt(request: {
  command: string
  source: string
  scope?: string
}): string {
  return [
    `Lo que se pide: ${request.command}`,
    request.scope ? `Se refiere sobre todo a ${request.scope}.` : '',
    `El programa:\n${request.source}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}
const lineOf = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

/** Lee un cambio de un objeto de la respuesta. `null` si no lo es. */
export function opOf(value: unknown): ChangeOp | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const op = text(raw.op).toLowerCase()
  const say = text(raw.say).trim().slice(0, 300)
  // El modelo copia a veces la sangría que la línea tiene en el archivo: aquí va sin ella (se la pone
  // quien la escribe, según dónde caiga). Con la suya y la nuestra, quedaba doble.
  const code = dedent(text(raw.code).replace(/\r\n/g, '\n').replace(/\s+$/, ''))
  if (op === 'cambiar' || op === 'change') {
    const line = lineOf(raw.linea ?? raw.line)
    return line === null || line === 0 || code.trim() === ''
      ? null
      : { op: 'change', line, code, say }
  }
  if (op === 'quitar' || op === 'remove') {
    const line = lineOf(raw.linea ?? raw.line)
    return line === null || line === 0 ? null : { op: 'remove', line, say }
  }
  if (op === 'añadir' || op === 'anadir' || op === 'add') {
    const inside = lineOf(raw.dentro ?? raw.inside)
    const after = lineOf(raw.tras ?? raw.after)
    const line = inside ?? after
    if (line === null || code.trim() === '') return null
    return { op: 'add', line, inside: inside !== null, code, say }
  }
  return null
}

/**
 * Traduce una línea del programa de antes de empezar a donde está ahora. Cada cambio ya hecho movió lo que
 * tenía debajo: se apuntan en orden (dónde, en las líneas de ese momento, y cuánto) y se aplican en orden.
 */
export class LineMap {
  private shifts: { after: number; by: number }[] = []

  now(line: number): number {
    let current = line
    for (const shift of this.shifts) if (current > shift.after) current += shift.by
    return current
  }

  /** Un cambio movió `by` líneas todo lo que había por debajo de la línea `after` (de ese momento). */
  moved(after: number, by: number): void {
    if (by !== 0) this.shifts.push({ after, by })
  }
}

export type Applied =
  | { ok: true; change: Change; line: number; effect: 'changed' | 'leaving' | 'born' }
  | { ok: false; error: string }

const statementAt = (program: Program, line: number): ProgramNode | undefined =>
  program.nodes.find((node) => node.range !== undefined && node.line === line)

/**
 * Las ediciones de un cambio sobre el programa de ahora. `line` es dónde mirar: la sentencia cambiada, la
 * que se va, o la primera de lo añadido.
 */
export function applyOp(program: Program, map: LineMap, op: ChangeOp): Applied {
  // La línea 0 es «antes de todo»: solo vale para añadir al principio.
  if (op.op === 'add' && op.line === 0) {
    const change = addCode(program, { at: 'start' }, op.code)
    return change.edits.length > 0 && change.select
      ? { ok: true, change, line: change.select.line, effect: 'born' }
      : { ok: false, error: 'No se pudo añadir al principio.' }
  }
  const at = map.now(op.line)
  const node = statementAt(program, at)
  if (!node) {
    // En esa línea no empieza ninguna sentencia (un `pass`, una línea en blanco, una que ya no está): no
    // es motivo para dejarlo todo a medias. Lo que se añade va a lo que envuelve esa línea —el cuerpo de
    // la clase o la función, donde un `pass` se sustituye— o, si no la envuelve nada, al final. Y lo que
    // se cambia o se quita ahí, si no hay nada que cambiar, se da por hecho.
    const owner = program.nodes
      .filter(
        (other) =>
          other.range?.head !== undefined && other.line < at && (other.lineEnd ?? other.line) >= at,
      )
      .sort((x, y) => y.line - x.line)[0]
    const rows = program.source.split('\n')
    const written = (rows[at - 1] ?? '').trim()
    // Cambiar una línea que no existe, o que no es un hueco (`pass`, `...`), sí es un error: no hay qué.
    const hole = written === 'pass' || written === '...'
    if (at > rows.length || (op.op === 'change' && !(hole && owner))) {
      return { ok: false, error: `En la línea ${op.line} no empieza ninguna sentencia.` }
    }
    if (op.op === 'remove') {
      return { ok: true, change: { edits: [] }, line: owner?.line ?? at, effect: 'leaving' }
    }
    const change = addCode(program, owner ? { into: owner.id } : {}, op.code)
    return change.edits.length > 0 && change.select
      ? { ok: true, change, line: change.select.line, effect: 'born' }
      : { ok: false, error: `En la línea ${op.line} no empieza ninguna sentencia.` }
  }
  if (op.op === 'change') {
    const change = replaceCode(program, node.id, op.code)
    // Dejarla como estaba no es un cambio, pero tampoco un fallo: se enseña igual, sin tocar nada.
    return { ok: true, change, line: at, effect: 'changed' }
  }
  if (op.op === 'remove') {
    const change = deleteNode(program, node.id)
    return change.edits.length > 0
      ? { ok: true, change, line: at, effect: 'leaving' }
      : { ok: false, error: `No se pudo quitar la línea ${op.line}.` }
  }
  const inside = op.inside && node.range?.head !== undefined
  const change = addCode(program, inside ? { into: node.id } : { after: node.id }, op.code)
  return change.edits.length > 0 && change.select
    ? { ok: true, change, line: change.select.line, effect: 'born' }
    : { ok: false, error: `No se pudo añadir junto a la línea ${op.line}.` }
}

/** Cuántas líneas más (o menos) tiene un texto tras unas ediciones. */
export function lineDelta(before: string, after: string): number {
  const count = (value: string) => value.split('\n').length
  return count(after) - count(before)
}

export const MAX_OPS = 25

export function modifySystem(): string {
  return [
    'Alguien te pide cambiar un programa en Python que ya está escrito y que un editor dibuja como un diagrama. No lo reescribas: di los cambios mínimos que hacen falta, uno por uno, y cuéntalos en voz alta.',
    'El programa te llega con sus números de línea. Tu respuesta son líneas JSON, una por cambio, sin nada más:',
    '{"op": "cambiar", "linea": 12, "code": "…", "say": "…"}   → la sentencia que empieza en esa línea pasa a ser «code». De una sentencia compuesta (def, for, while, if, with) escribe solo su cabecera: su cuerpo se queda como está.',
    '{"op": "quitar", "linea": 12, "say": "…"}   → se quita esa sentencia (con su cuerpo, si es compuesta).',
    '{"op": "añadir", "tras": 12, "code": "…", "say": "…"}   → se añade «code» justo detrás de la sentencia de esa línea, a su misma altura. Con "dentro": 12 en vez de "tras", se añade al final del cuerpo de esa sentencia compuesta. "tras": 0 es al principio del archivo.',
    'En «añadir», «code» son sentencias completas (una compuesta, con su cuerpo), sin sangría inicial y con 4 espacios por nivel.',
    'Los números de línea son SIEMPRE los del programa que te llega, aunque tus cambios anteriores muevan líneas: de eso se encarga el editor.',
    'Cambia solo lo que la orden pide. Si un nombre deja de ser cierto (una función «sumar» que ahora resta), cámbialo en su definición y en cada sitio donde se usa, cada uno con su «cambiar».',
    '«say»: una frase corta, en español y sin código, que diga qué cambia ahí y por qué. Se leerá en voz alta mientras el cambio se ve en el diagrama.',
    `Como mucho ${MAX_OPS} cambios. Si no hay nada que cambiar, no escribas ninguna línea.`,
  ].join('\n')
}

export function modifyPrompt(request: { command: string; scope: string; context: string }): string {
  return [`Orden: ${request.command}`, request.scope, request.context]
    .filter((part) => part !== '')
    .join('\n\n')
}
