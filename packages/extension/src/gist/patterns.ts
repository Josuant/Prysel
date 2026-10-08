import type { Sample } from './sample.ts'
import { showValue, type Value } from './value.ts'

/**
 * La **regla** de una función que convierte por casos: «si es 1, un asterisco; si no, un punto». Es lo que
 * dice de verdad qué hace `mostrar_tablero`, más que sus dos bucles.
 *
 * Se lee del código (una decisión cuyas ramas hacen lo mismo con un literal distinto, o un `a if x == 1 else
 * b`) y **se comprueba con la muestra**: aplicada a lo que entró, tiene que dar lo que salió. Si no lo da, no
 * hay regla: se enseña la muestra sola, que siempre es verdad.
 */
export interface Rule {
  /** Lo que se mira para decidir (`celda`). */
  subject: string
  /** Cada caso: con qué valor, qué da. `when: null` es «en otro caso». */
  cases: { when: string | null; gives: string }[]
  /** La entrada a la que se aplica (su nombre entre lo que recibe la función). */
  input: string
  /** Se aplica a cada elemento de esa entrada (y no a la entrada entera). */
  each: boolean
}

const LIT = String.raw`-?\d+(?:\.\d+)?|"[^"\n]*"|'[^'\n]*'|\bTrue\b|\bFalse\b|\bNone\b`
const HEAD = new RegExp(String.raw`^(\s*)(if|elif)\s+(.+?)\s*==\s*(${LIT})\s*:\s*$`)
const ELSE = /^(\s*)else\s*:\s*$/
const TERNARY = new RegExp(
  String.raw`(${LIT})\s+if\s+([\w.\[\]]+)\s*==\s*(${LIT})\s+else\s+(${LIT})(?!\s+if\b)`,
)

const indentOf = (row: string) => row.length - row.trimStart().length

/** Un literal sin su envoltorio: lo que se compara y lo que se enseña (`"*"` → `*`). */
export function bare(literal: string): string {
  const text = literal.trim()
  if (/^(["']).*\1$/s.test(text)) return text.slice(1, -1)
  return /^-?\d/.test(text) && Number.isFinite(Number(text)) ? String(Number(text)) : text
}

type Candidate = Pick<Rule, 'subject' | 'cases'>

/** Lo que hacen las ramas, si todas hacen lo mismo cambiando un solo literal: ese literal, por rama. */
function varying(bodies: readonly string[]): string[] | null {
  const split = bodies.map((body) => body.trim().split(new RegExp(`(${LIT})`)))
  const first = split[0]
  if (!first || split.some((parts) => parts.length !== first.length)) return null
  const differing: number[] = []
  for (let at = 0; at < first.length; at++) {
    if (split.every((parts) => parts[at] === first[at])) continue
    // Lo que no es un literal tiene que ser igual en todas: si no, no hacen «lo mismo».
    if (at % 2 === 0) return null
    differing.push(at)
  }
  const [only] = differing
  return differing.length === 1 && only !== undefined
    ? split.map((parts) => parts[only] ?? '')
    : null
}

/** Las reglas que el texto de una función deja leer. Aún sin comprobar. */
export function candidateRules(code: string): Candidate[] {
  const rows = code.split('\n')
  const found: Candidate[] = []
  for (let at = 0; at < rows.length; at++) {
    const row = rows[at] ?? ''
    const ternary = TERNARY.exec(row)
    if (ternary) {
      const [, yes = '', subject = '', when = '', no = ''] = ternary
      found.push({
        subject,
        cases: [
          { when, gives: yes },
          { when: null, gives: no },
        ],
      })
    }
    const head = HEAD.exec(row)
    if (!head || head[2] !== 'if') continue
    const indent = indentOf(row)
    const subject = head[3] ?? ''
    const whens: (string | null)[] = []
    const bodies: string[] = []
    let line = at
    for (;;) {
      const opener = rows[line] ?? ''
      const branch = HEAD.exec(opener)
      const otherwise = ELSE.exec(opener)
      const fits =
        indentOf(opener) === indent && (line === at || branch?.[2] === 'elif' || otherwise !== null)
      if (!fits) break
      if (branch && branch[3] !== subject) break
      // Cada rama es una sola sentencia: con más, ya no es «da esto».
      const body = rows[line + 1] ?? ''
      const after = rows[line + 2]
      if (body.trim() === '' || indentOf(body) <= indent) break
      if (after !== undefined && after.trim() !== '' && indentOf(after) > indent) break
      whens.push(branch ? (branch[4] ?? '') : null)
      bodies.push(body)
      line += 2
      if (otherwise) break
    }
    if (bodies.length < 2) continue
    const gives = varying(bodies)
    if (!gives) continue
    found.push({
      subject,
      cases: whens.map((when, index) => ({ when, gives: gives[index] ?? '' })),
    })
  }
  return found
}

/** Los valores sueltos de un valor, en orden: una rejilla, celda a celda. `null` si lleva algo que no se lee. */
function atoms(value: Value): string[] | null {
  if (value.kind === 'atom') return [bare(value.text)]
  if (value.kind !== 'list' || value.more || value.shape === 'set') return null
  const all: string[] = []
  for (const item of value.items) {
    const inner = atoms(item)
    if (!inner) return null
    all.push(...inner)
  }
  return all
}

/** Un texto sin lo que solo es forma (espacios, saltos, comas, corchetes, comillas): queda lo que dice. */
const essence = (text: string) => text.replace(/[\s,[\]()'"]/g, '')

/**
 * La regla de la función, si tiene una y la muestra la confirma: aplicada a una de sus entradas (elemento a
 * elemento), da exactamente lo que imprimió, devolvió o dejó cambiado.
 */
export function ruleFor(code: string, sample: Sample): Rule | null {
  if (sample.error !== undefined) return null
  const outputs = [
    ...(sample.printed !== undefined ? [sample.printed] : []),
    ...(sample.returned ? [showValue(sample.returned)] : []),
    ...(sample.changed ?? []).map((change) => showValue(change.after)),
  ].map(essence)
  if (outputs.length === 0) return null
  for (const candidate of candidateRules(code)) {
    const table = new Map(
      candidate.cases.flatMap((entry) =>
        entry.when === null ? [] : [[bare(entry.when), bare(entry.gives)] as const],
      ),
    )
    const fallback = candidate.cases.find((entry) => entry.when === null)
    for (const input of sample.inputs) {
      const entering = atoms(input.value)
      if (!entering || entering.length === 0) continue
      const produced: string[] = []
      for (const item of entering) {
        const gives = table.get(item) ?? (fallback ? bare(fallback.gives) : undefined)
        if (gives === undefined) break
        produced.push(gives)
      }
      if (produced.length !== entering.length) continue
      const said = essence(produced.join(''))
      if (said !== '' && outputs.includes(said))
        return { ...candidate, input: input.name, each: input.value.kind === 'list' }
    }
  }
  return null
}
