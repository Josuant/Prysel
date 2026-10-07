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
const lineOf = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

/** Lee un cambio de un objeto de la respuesta. `null` si no lo es. */
export function opOf(value: unknown): ChangeOp | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const op = text(raw.op).toLowerCase()
  const say = text(raw.say).trim().slice(0, 300)
  const code = text(raw.code).replace(/\r\n/g, '\n').replace(/\s+$/, '')
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
