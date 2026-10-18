import type { Program } from '@prysel/python'
import { indexOf, isShownList, stateAt, type Shown, type Trace } from '../trace.ts'
import { hashOf } from './facts.ts'
import { showValue, valueOf } from './value.ts'

/**
 * «Cómo funciona» un `if`, comprobado: las agujas del tren. Cada vez que la ejecución llega a él, con qué
 * valores se comprobó cada condición (`n <= 1` → `3 <= 1`), qué dio y por qué rama siguió; y cuántas veces fue
 * por cada una. Todo sale de la traza: nada de lo que se enseña lo ha escrito una IA.
 */

export interface Arm {
  kind: 'if' | 'elif' | 'else'
  /** La cabecera, sin los dos puntos: `if n <= 1`, `elif x > 0`, `else`. */
  head: string
  /** La condición (`null` en el `else`). */
  test: string | null
  /** La línea de su cabecera y la última de su cuerpo. */
  line: number
  lineEnd: number
}

export interface ConditionFacts {
  /** El id de su nodo en el programa. */
  id: string
  line: number
  lineEnd: number
  arms: Arm[]
  code: string
  hash: string
}

/** Una vez que se llegó al `if`. */
export interface Visit {
  /** El brazo por el que siguió (su índice en `arms`); −1 si no entró en ninguno (no había `else`). */
  arm: number
  /** Por brazo: la condición con los valores de ese momento, o `null` si no llegó a comprobarse. */
  tests: (string | null)[]
  /** Por brazo: lo que dio su condición (`null`: no se comprobó, o es el `else`). */
  verdicts: (boolean | null)[]
}

export interface Switch {
  arms: Arm[]
  /** Las primeras visitas, en orden. */
  visits: Visit[]
  /** Cuántas veces se llegó, de verdad. */
  total: number
  /** Por brazo, cuántas veces se fue por él; el último, cuántas por ninguno. */
  totals: number[]
  none: number
}

/** Cuántas visitas se cuentan una a una: más ya no se leen, se suman. */
export const MAX_VISITS = 8
/** Cuántas visitas se miran como mucho, para el recuento. */
const MAX_COUNTED = 400

const ARM = /^\s*(elif\s+(.+?)|else)\s*:\s*(?:#.*)?$/
const IF = /^\s*if\s+(.+?)\s*:\s*(?:#.*)?$/
const indentOf = (row: string) => row.length - row.trimStart().length

/** Los `if` del programa (no sus `elif`, que van dentro) de los que se puede enseñar cómo funcionan. */
export function conditionsIn(program: Program): ConditionFacts[] {
  const rows = program.source.split(/\r?\n/)
  const found: ConditionFacts[] = []
  for (const node of program.nodes) {
    if (node.kind !== 'control.condition') continue
    const first = rows[node.line - 1] ?? ''
    const head = IF.exec(first)
    if (!head) continue
    const own = indentOf(first)
    // El final del `if` entero: la última línea con más sangría que él, tras la cabecera y sus cláusulas.
    let end = node.line
    const heads: { line: number; kind: Arm['kind']; test: string | null; head: string }[] = [
      {
        line: node.line,
        kind: 'if',
        test: head[1] ?? '',
        head: first.trim().replace(/:\s*(?:#.*)?$/, ''),
      },
    ]
    for (let line = node.line + 1; line <= rows.length; line++) {
      const row = rows[line - 1] ?? ''
      if (row.trim() === '' || /^\s*#/.test(row)) continue
      const indent = indentOf(row)
      if (indent > own) {
        end = line
        continue
      }
      const clause = indent === own ? ARM.exec(row) : null
      if (!clause) break
      const isElse = (clause[1] ?? '') === 'else'
      heads.push({
        line,
        kind: isElse ? 'else' : 'elif',
        test: isElse ? null : (clause[2] ?? ''),
        head: row.trim().replace(/:\s*(?:#.*)?$/, ''),
      })
      end = line
      if (isElse) {
        // Tras el `else` no hay más cláusulas: su cuerpo llega hasta donde baja la sangría.
        for (let next = line + 1; next <= rows.length; next++) {
          const body = rows[next - 1] ?? ''
          if (body.trim() === '' || /^\s*#/.test(body)) continue
          if (indentOf(body) <= own) break
          end = next
        }
        break
      }
    }
    if (end === node.line) continue
    const arms = heads.map((arm, k): Arm => ({
      ...arm,
      lineEnd: (heads[k + 1]?.line ?? end + 1) - 1,
    }))
    // La última cláusula acaba donde acaba el `if` (no en la línea en blanco que la siga).
    const last = arms[arms.length - 1]
    if (last) last.lineEnd = end
    const code = rows.slice(node.line - 1, end).join('\n')
    found.push({ id: node.id, line: node.line, lineEnd: end, arms, code, hash: hashOf(code) })
  }
  return found
}

const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'is',
  'True',
  'False',
  'None',
  'if',
  'else',
  'lambda',
  'self',
  'cls',
])

/** Un índice sencillo con los valores de ese momento: `j`, `j + 1`, `i - 1`, `0`. `null` si no es tan sencillo. */
function indexValue(text: string, locals: Readonly<Record<string, Shown>>): number | null {
  const terms = text.replace(/\s+/g, '').split(/(?=[+-])/)
  if (terms.length === 0 || terms.some((term) => !/^[+-]?(\d+|[A-Za-z_]\w*)$/.test(term)))
    return null
  let total = 0
  for (const term of terms) {
    const sign = term.startsWith('-') ? -1 : 1
    const bare = term.replace(/^[+-]/, '')
    const value = /^\d+$/.test(bare) ? Number(bare) : locals[bare]
    if (typeof value !== 'number' || !Number.isInteger(value)) return null
    total += sign * value
  }
  return total
}

/** Un valor dicho corto, o `null` si no se lee corto (y entonces se deja el nombre). */
const brief = (value: Shown | undefined): string | null => {
  const text = showValue(valueOf(value))
  return text.length <= 12 && !text.includes('\n') ? text : null
}

/**
 * La condición con los valores de ese momento en lugar de los nombres: `n <= 1` → `3 <= 1`, `xs[j] > xs[j + 1]`
 * → `5 > 2`. Solo los nombres sueltos (no un atributo, no una llamada), los elementos de una lista con un índice
 * sencillo, y solo si su valor se lee corto; lo demás se queda como está.
 */
export function substitute(test: string, locals: Readonly<Record<string, Shown>>): string {
  // Lo que va entre comillas no se toca.
  return test
    .split(/("[^"]*"|'[^']*')/)
    .map((part, at) =>
      at % 2 === 1
        ? part
        : part
            .replace(
              /(?<![\w.])([A-Za-z_]\w*)\[([^[\]]+)\]/g,
              (whole: string, name: string, index: string) => {
                const list = locals[name]
                const at = isShownList(list) ? indexValue(index, locals) : null
                if (!isShownList(list) || at === null) return whole
                const item = list.l[at < 0 ? list.l.length + at : at]
                const text = item === undefined ? null : brief(item)
                return text ?? whole
              },
            )
            .replace(/(?<![\w.'"])([A-Za-z_]\w*)(?![\w(.[])/g, (name: string) => {
              if (KEYWORDS.has(name) || !(name in locals)) return name
              return brief(locals[name]) ?? name
            }),
    )
    .join('')
}

/** El brazo (su índice) cuyo cuerpo contiene esta línea, o −1. */
const armOf = (facts: ConditionFacts, line: number) =>
  facts.arms.findIndex((arm) => line > arm.line && line <= arm.lineEnd)

/**
 * Las visitas al `if`, con el recuento por brazo. `null` si la ejecución nunca llegó a él.
 */
export function bestSwitch(
  trace: Trace,
  facts: ConditionFacts,
  index = indexOf(trace),
): Switch | null {
  const events = trace.events
  const visits: Visit[] = []
  const totals = facts.arms.map(() => 0)
  let none = 0
  let total = 0
  const localsAt = (step: number, frame: number) =>
    stateAt(index, step).frames.find((candidate) => candidate.id === frame)?.locals ?? {}
  for (let i = 0; i < events.length && total < MAX_COUNTED; i++) {
    const event = events[i]
    if (!event || event.k !== 'line' || event.l !== facts.line) continue
    const frame = event.f
    const detailed = visits.length < MAX_VISITS
    const tests: (string | null)[] = facts.arms.map(() => null)
    const verdicts: (boolean | null)[] = facts.arms.map(() => null)
    const check = (arm: number, step: number) => {
      const test = facts.arms[arm]?.test
      if (detailed && test) tests[arm] = substitute(test, localsAt(step, frame))
    }
    check(0, i)
    let checked = 0
    let taken = -1
    for (let j = i + 1; j < events.length; j++) {
      const next = events[j]
      if (!next || next.f !== frame) continue
      if (next.k !== 'line') {
        // Salió del marco (un `return` en la propia condición, o un error al comprobarla).
        if (next.k === 'return') break
        continue
      }
      const header = facts.arms.findIndex((arm) => arm.kind === 'elif' && arm.line === next.l)
      if (header >= 0) {
        checked = header
        check(header, j)
        continue
      }
      taken = armOf(facts, next.l)
      break
    }
    // Las comprobadas antes de la que se tomó dieron que no; la tomada, que sí (salvo el `else`).
    for (let arm = 0; arm <= Math.max(checked, taken); arm++) {
      if (facts.arms[arm]?.kind === 'else') continue
      if (arm > checked && arm !== taken) continue
      verdicts[arm] = arm === taken
    }
    total++
    if (taken >= 0) totals[taken] = (totals[taken] ?? 0) + 1
    else none++
    if (detailed) visits.push({ arm: taken, tests, verdicts })
  }
  if (total === 0) return null
  return { arms: facts.arms, visits, total, totals, none }
}
