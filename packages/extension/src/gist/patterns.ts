import type { Decider } from '../jev/client.ts'
import type { Sample } from './sample.ts'
import { showValue, type Value } from './value.ts'

/**
 * La **regla** de una función: lo que hace con lo que recibe, dicho en una línea. «Cada celda: si es 1, un
 * asterisco; si no, un punto», «se queda con los pares», «suma». Es lo que dice de verdad qué hace
 * `mostrar_tablero`, más que sus dos bucles.
 *
 * Se lee del código (su forma) y **se comprueba con la muestra** (sus datos): aplicada a lo que entró, tiene
 * que dar lo que salió. Si no lo da, no hay regla: se enseña la muestra sola, que siempre es verdad. Además
 * de la regla, queda dicho **qué pasó con cada elemento** (por qué caso fue, si se quedó, cuánto llevaba la
 * cuenta): es lo que permite contarlo paso a paso.
 */
export type Rule = CasesRule | FilterRule | FoldRule

interface Applied {
  /** La entrada a la que se aplica (su nombre entre lo que recibe la función). */
  input: string
}

/** Convierte por casos: cada elemento, según lo que valga, da una cosa. */
export interface CasesRule extends Applied {
  kind: 'cases'
  /** Lo que se mira para decidir (`celda`). */
  subject: string
  /** Cada caso: con qué valor, qué da. `when: null` es «en otro caso». */
  cases: { when: string | null; gives: string }[]
  /** Se aplica a cada elemento de esa entrada (y no a la entrada entera). */
  each: boolean
  /** Por qué caso fue cada elemento de la muestra, en orden. */
  via: number[]
  /**
   * Los casos no son valores sino **caminos**: qué condiciones se cumplieron (`esta_viva y no
   * debe_sobrevivir`). Salen de la traza (por dónde fue cada vuelta), no de leer literales.
   */
  spoken?: boolean
}

/** Se queda con algunos: lo que sale son elementos de lo que entró, en su orden. */
export interface FilterRule extends Applied {
  kind: 'filter'
  /** La condición, como está escrita en el código (si se encontró). */
  condition: string | null
  /** Qué elementos de la muestra se quedaron, en orden. */
  keeps: boolean[]
}

/** Reduce a un número: la suma, cuántos hay, cuántos cumplen algo, el mayor o el menor. */
export interface FoldRule extends Applied {
  kind: 'fold'
  op: 'sum' | 'count' | 'count-if' | 'max' | 'min'
  /** Con `count-if`: qué se cuenta, como está en el código (`== 1`, `> 3`). */
  condition?: string
  /** Lo que llevaba la cuenta tras cada elemento de la muestra. */
  running: string[]
  /** Qué elementos cambiaron la cuenta (los que suman, los que cuentan, los que baten el récord). */
  counts: boolean[]
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

type Candidate = Pick<CasesRule, 'subject' | 'cases'>

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

/** Lo que salió, como textos sin forma: lo impreso, lo devuelto y lo que quedó cambiado. */
const outputsOf = (sample: Sample) =>
  [
    ...(sample.printed !== undefined ? [sample.printed] : []),
    ...(sample.returned ? [showValue(sample.returned)] : []),
    ...(sample.changed ?? []).map((change) => showValue(change.after)),
  ].map(essence)

function casesRules(code: string, sample: Sample): CasesRule[] {
  const outputs = outputsOf(sample)
  const found: CasesRule[] = []
  for (const candidate of candidateRules(code)) {
    const whens = candidate.cases.map((entry) => (entry.when === null ? null : bare(entry.when)))
    const fallback = whens.indexOf(null)
    for (const input of sample.inputs) {
      const entering = atoms(input.value)
      if (!entering || entering.length === 0) continue
      const via = entering.map((item) => {
        const at = whens.indexOf(item)
        return at >= 0 ? at : fallback
      })
      if (via.includes(-1)) continue
      const said = essence(via.map((at) => bare(candidate.cases[at]?.gives ?? '')).join(''))
      if (said !== '' && outputs.includes(said))
        found.push({
          kind: 'cases',
          ...candidate,
          input: input.name,
          each: input.value.kind === 'list',
          via,
        })
    }
  }
  return found
}

/** Dos valores sueltos comparados como Python los compararía: como números si lo son, si no como textos. */
function compare(a: string, op: string, b: string): boolean | null {
  const [x, y] = [Number(a), Number(b)]
  const numeric = a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y)
  if (op === '==') return numeric ? x === y : a === b
  if (op === '!=') return numeric ? x !== y : a !== b
  if (!numeric) return null
  if (op === '<') return x < y
  if (op === '<=') return x <= y
  if (op === '>') return x > y
  if (op === '>=') return x >= y
  return null
}

/**
 * Una condición sencilla sobre un elemento (`n % 2 == 0`, `x > 3`, `celda == 1`, `not x`), hecha función: lo
 * que da para un valor. `null` si no es de las que se saben evaluar: entonces no se evalúa, no se adivina.
 */
export function testOf(condition: string): ((item: string) => boolean | null) | null {
  const text = condition.trim()
  const name = String.raw`[A-Za-z_][\w.\[\]]*`
  const modulo = new RegExp(String.raw`^${name}\s*%\s*(\d+)\s*(==|!=)\s*(\d+)$`).exec(text)
  if (modulo) {
    const [, by = '1', op = '==', rest = '0'] = modulo
    return (item) =>
      Number.isInteger(Number(item)) && item !== ''
        ? compare(String(((Number(item) % Number(by)) + Number(by)) % Number(by)), op, rest)
        : null
  }
  const plain = new RegExp(String.raw`^${name}\s*(==|!=|<=|>=|<|>)\s*(${LIT})$`).exec(text)
  if (plain) {
    const [, op = '==', literal = ''] = plain
    return (item) => compare(item, op, bare(literal))
  }
  const truthy = new RegExp(String.raw`^(not\s+)?${name}$`).exec(text)
  if (truthy) {
    const negated = truthy[1] !== undefined
    return (item) => !['0', '', 'False', 'None'].includes(item) !== negated
  }
  return null
}

/** Las condiciones que el código pone para quedarse con algo o para contarlo. */
function conditionsIn(code: string): string[] {
  const found: string[] = []
  // `[x for x in xs if COND]`, y `if COND:` en un bucle.
  for (const match of code.matchAll(/\bfor\s+[\w, ]+\s+in\s+[^\]\n]+?\s+if\s+([^\]\n]+?)\s*[\])]/g))
    found.push(match[1] ?? '')
  for (const match of code.matchAll(/^\s*if\s+(.+?)\s*:\s*$/gm)) found.push(match[1] ?? '')
  return found.filter((condition) => condition !== '')
}

function filterRules(code: string, sample: Sample): FilterRule[] {
  const out = sample.returned ?? sample.changed?.[0]?.after
  if (!out || out.kind !== 'list' || !out.items.every((item) => item.kind === 'atom')) return []
  const left = atoms(out)
  if (!left) return []
  const conditions = conditionsIn(code)
  // Sin una condición en el código no es «quedarse con algunos»: sería otra cosa que se le parece.
  if (conditions.length === 0) return []
  const found: FilterRule[] = []
  for (const input of sample.inputs) {
    const entering = atoms(input.value)
    if (!entering || input.value.kind !== 'list' || left.length >= entering.length) continue
    // Lo que salió tiene que ser parte de lo que entró, en su orden.
    const keeps: boolean[] = []
    let next = 0
    for (const item of entering) {
      const kept = next < left.length && left[next] === item
      keeps.push(kept)
      if (kept) next++
    }
    if (next !== left.length) continue
    // La condición es la que, evaluada, da justo esos; si ninguna se sabe evaluar, la primera, como texto.
    const exact = conditions.find((condition) => {
      const test = testOf(condition)
      return test !== null && entering.every((item, at) => test(item) === keeps[at])
    })
    const unknown = conditions.find((condition) => testOf(condition) === null)
    if (exact === undefined && unknown === undefined) continue
    found.push({ kind: 'filter', input: input.name, condition: exact ?? unknown ?? null, keeps })
  }
  return found
}

function foldRules(code: string, sample: Sample): FoldRule[] {
  const out = sample.returned
  if (!out || out.kind !== 'atom' || out.type !== 'number') return []
  const result = Number(out.text)
  // `total = total + 1` es `total += 1` escrito largo: se lee igual. (Es como lo escribe a menudo una IA.)
  const bareCode = code
    .replace(/"[^"\n]*"|'[^'\n]*'/g, '""')
    .replace(/#.*$/gm, '')
    .replace(/\b([A-Za-z_]\w*)\s*=\s*\1\s*\+(?!=)/g, '$1 +=')
  const found: FoldRule[] = []
  const show = (value: number) => String(Math.round(value * 1e6) / 1e6)
  for (const input of sample.inputs) {
    const entering = atoms(input.value)
    if (!entering || input.value.kind !== 'list' || entering.length === 0) continue
    const add = (
      op: FoldRule['op'],
      steps: { value: number; counts: boolean }[],
      condition?: string,
    ) => {
      if (steps.at(-1)?.value !== result) return
      found.push({
        kind: 'fold',
        input: input.name,
        op,
        ...(condition !== undefined ? { condition } : {}),
        running: steps.map((step) => show(step.value)),
        counts: steps.map((step) => step.counts),
      })
    }
    // Cuántos cumplen algo: la condición es del código, y la cuenta tiene que salir.
    if (/\+=\s*1\b|\.count\(|\bsum\(|\blen\(/.test(bareCode)) {
      for (const condition of conditionsIn(code)) {
        const test = testOf(condition)
        if (!test) continue
        let total = 0
        const steps = entering.map((item) => {
          const counts = test(item) === true
          if (counts) total++
          return { value: total, counts }
        })
        add('count-if', steps, condition.replace(/^[A-Za-z_][\w.[\]]*\s*(?=[=!<>%])/, ''))
      }
    }
    const numbers = entering.map(Number)
    if (numbers.every((n, at) => entering[at] !== '' && Number.isFinite(n))) {
      if (/\bsum\(|\+=\s*(?!1\b)/.test(bareCode)) {
        let total = 0
        add(
          'sum',
          numbers.map((n) => ({ value: (total += n), counts: n !== 0 })),
        )
      }
      for (const [op, better, hint] of [
        ['max', (n: number, best: number) => n > best, /\bmax\(|>/],
        ['min', (n: number, best: number) => n < best, /\bmin\(|</],
      ] as const) {
        if (!hint.test(bareCode)) continue
        let best = Number.NaN
        add(
          op,
          numbers.map((n) => {
            const counts = Number.isNaN(best) || better(n, best)
            if (counts) best = n
            return { value: best, counts }
          }),
        )
      }
    }
    if (/\blen\(|\+=\s*1\b/.test(bareCode))
      add(
        'count',
        entering.map((_, at) => ({ value: at + 1, counts: true })),
      )
  }
  return found
}

/** Una condición, dicha corta: una llamada queda en su nombre (`esta_viva(t, f, c)` → `esta_viva`). */
const short = (condition: string) => {
  const text = condition.trim().replace(/\b([A-Za-z_]\w*)\((?:[^()]|\([^()]*\))*\)/g, '$1')
  return text.length > 26 ? `${text.slice(0, 25)}…` : text
}

/** Cuántos caminos distintos puede tener una regla para seguir siendo una regla y no un listado. */
const MAX_PATHS = 6

/**
 * La regla que cuenta la traza cuando las decisiones no comparan con un literal (llaman a otra función, o
 * miran varias cosas): cada vuelta del bucle fue por un camino —unas condiciones sí, otras no— y dejó un
 * resultado. Si **el mismo camino da siempre lo mismo**, eso es una regla por casos, y es verdad para toda
 * la muestra: `esta_viva y debe_sobrevivir → 1`, `no esta_viva y debe_nacer → 1`…
 */
function pathRules(code: string, sample: Sample): CasesRule[] {
  const paths = sample.paths
  if (!paths) return []
  const steps = paths.length
  // Lo que sale tiene que ser un resultado por vuelta: una rejilla o una lista del mismo tamaño, o un
  // carácter impreso por cada una.
  const results = [
    ...(sample.returned ? [atoms(sample.returned)] : []),
    ...(sample.changed ?? []).map((change) => atoms(change.after)),
    ...(sample.printed !== undefined ? [[...sample.printed.replace(/\n/g, '')]] : []),
  ].find((items) => items?.length === steps)
  const input = sample.inputs.find(
    (candidate) => candidate.value.kind === 'list' && atoms(candidate.value)?.length === steps,
  )
  if (!results || !input) return []
  const rows = code.split('\n')
  const indentOf = (row: string) => row.length - row.trimStart().length
  /** Lo que dice un camino: de cada decisión por la que pasó, si se cumplió. */
  const say = (path: readonly number[]) => {
    const parts = path.flatMap((line) => {
      const row = rows[line] ?? ''
      const condition = /^\s*(?:if|elif)\s+(.+?)\s*:\s*(?:#.*)?$/.exec(row)?.[1]
      if (condition === undefined) return []
      // Se cumplió si la vuelta entró en lo que cuelga de ella.
      let end = line
      for (let at = line + 1; at < rows.length; at++) {
        const below = rows[at] ?? ''
        if (below.trim() === '') continue
        if (indentOf(below) <= indentOf(row)) break
        end = at
      }
      const held = path.some((other) => other > line && other <= end)
      return [`${held ? '' : 'no '}${short(condition)}`]
    })
    return parts.length > 0 ? parts.join(' y ') : 'siempre'
  }
  const cases: { key: string; when: string; gives: string }[] = []
  const via: number[] = []
  for (const [at, path] of paths.entries()) {
    const key = path.join(',')
    const gives = results[at] ?? ''
    let index = cases.findIndex((entry) => entry.key === key)
    if (index < 0) {
      if (cases.length >= MAX_PATHS) return []
      index = cases.push({ key, when: say(path), gives }) - 1
    }
    // El mismo camino con otro resultado: el camino no lo explica. No hay regla.
    else if (cases[index]?.gives !== gives) return []
    via.push(index)
  }
  // Con un solo camino, o si todos dan lo mismo, no hay nada que contar.
  if (cases.length < 2 || new Set(cases.map((entry) => entry.gives)).size < 2) return []
  // Dos caminos que se dicen igual (difieren en algo que no es una decisión) confundirían.
  if (new Set(cases.map((entry) => entry.when)).size < cases.length) return []
  return [
    {
      kind: 'cases',
      subject: 'elemento',
      cases: cases.map(({ when, gives }) => ({ when, gives })),
      input: input.name,
      each: true,
      via,
      spoken: true,
    },
  ]
}

/**
 * Todas las reglas que el código deja leer **y** la muestra confirma, de la más concreta a la menos. Casi
 * siempre es una o ninguna; con varias (una lista de un solo elemento: su suma es también su mayor), hay que
 * elegir.
 */
export function verifiedRules(code: string, sample: Sample): Rule[] {
  if (sample.error !== undefined) return []
  const literal = casesRules(code, sample)
  const all: Rule[] = [
    ...literal,
    // Por caminos solo si no hay ya una regla por valores: dirían lo mismo, peor.
    ...(literal.length === 0 ? pathRules(code, sample) : []),
    ...filterRules(code, sample),
    ...foldRules(code, sample),
  ]
  // La misma regla leída dos veces (dos condiciones iguales) no es una duda.
  const seen = new Set<string>()
  return all.filter((rule) => {
    const key = JSON.stringify([rule.kind, rule.input, 'op' in rule ? rule.op : '', ruleSays(rule)])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** La regla de la función, si tiene una y la muestra la confirma. Con varias, la más concreta. */
export function ruleFor(code: string, sample: Sample): Rule | null {
  return verifiedRules(code, sample)[0] ?? null
}

/** La regla dicha en una frase: es lo que se le da a elegir al JEV, y lo que se lee en la tarjeta. */
export function ruleSays(rule: Rule): string {
  if (rule.kind === 'cases') {
    const cases = rule.cases
      .map((entry) => `${entry.when === null ? 'otro' : bare(entry.when)} → ${bare(entry.gives)}`)
      .join(', ')
    return `Convierte ${rule.each ? 'cada elemento' : 'el valor'} por casos: ${cases}.`
  }
  if (rule.kind === 'filter')
    return `Se queda con algunos elementos${rule.condition ? `: los que cumplen ${rule.condition}` : ''}.`
  if (rule.op === 'sum') return 'Suma todos los elementos.'
  if (rule.op === 'count') return 'Cuenta cuántos elementos hay.'
  if (rule.op === 'count-if') return `Cuenta cuántos elementos cumplen ${rule.condition ?? 'algo'}.`
  return rule.op === 'max' ? 'Busca el mayor.' : 'Busca el menor.'
}

/** Con cuánta certeza del JEV se le hace caso al elegir; con menos, queda la más concreta. */
export const RULE_THRESHOLD = 0.5

/**
 * Entre varias reglas que la muestra confirma por igual, el JEV dice cuál describe lo que hace la función
 * (ha visto su código). Todas son verdad para esa muestra: lo que elige es cuál es la intención.
 */
export async function pickRule(
  decider: Decider,
  fn: { name: string; code: string },
  rules: readonly Rule[],
): Promise<Rule | null> {
  const [first] = rules
  if (rules.length < 2 || !first) return first ?? null
  const { answers } = await decider.decide({
    state: { funcion: fn.name, codigo: fn.code },
    questions: {
      regla: {
        type: 'choice',
        instructions:
          'El campo `codigo` es una función de Python. ¿Cuál de estas frases describe lo que hace?',
        criteria: Object.fromEntries(rules.map((rule, at) => [`r${at + 1}`, ruleSays(rule)])),
      },
    },
  })
  const answer = answers['regla']
  if (answer?.type !== 'choice' || answer.confidence < RULE_THRESHOLD) return first
  return rules[Number(answer.choice.slice(1)) - 1] ?? first
}
