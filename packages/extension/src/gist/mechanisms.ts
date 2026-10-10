import type { Sample } from './sample.ts'
import { showValue, type Value } from './value.ts'

/**
 * El **mecanismo** de una función: no solo qué entra y qué sale, sino cómo se llega de lo uno a lo otro. «El
 * hijo lleva el principio de un padre y el final del otro», «cuenta las posiciones que coinciden con el
 * objetivo», «se queda con los dos de mejor nota», «la lista se va llenando de uno en uno».
 *
 * Como las reglas (`patterns.ts`), un mecanismo **se comprueba con la muestra**: se propone por la forma de los
 * datos (dos secuencias del mismo largo, una lista y sus notas…) y solo vale si, aplicado a lo que entró, da
 * exactamente lo que salió. Lo que no se puede comprobar no se enseña como mecanismo.
 */

interface Applied {
  /** La entrada a la que se aplica (o la que más pesa): por ella se distinguen dos mecanismos parecidos. */
  input: string
}

/** De dónde viene cada elemento de lo que sale: de una entrada, de la otra, de cualquiera (son iguales ahí) o de ninguna. */
export type Origin = 'a' | 'b' | 'both' | 'new'

/** Mezcla dos entradas: cada elemento de lo que sale está, en su misma posición, en una de las dos. */
export interface MixRule extends Applied {
  kind: 'mix'
  a: { name: string; cells: string[] }
  b: { name: string; cells: string[] }
  out: string[]
  from: Origin[]
}

/** Compara, posición a posición, con otra secuencia (a menudo un objetivo que no recibe: lo lee del programa). */
export interface MatchRule extends Applied {
  kind: 'match'
  cells: string[]
  target: { name: string; cells: string[]; hidden: boolean }
  /** Qué posiciones coinciden. */
  hits: boolean[]
  /** Lo que devuelve: cuántas coinciden (`same`) o cuántas no (`different`). */
  counts: 'same' | 'different'
}

/** Se queda con los mejores (o los peores) según una nota: la suya, o la que le dan en otra lista. */
export interface PodiumRule extends Applied {
  kind: 'podium'
  /** La lista de las notas, si van aparte. */
  scores: string | null
  order: 'max' | 'min'
  /** Cada candidato, en su orden de entrada: su nota y el puesto en que quedó (`null`: no fue elegido). */
  ranked: { text: string; score: string; place: number | null }[]
}

/** Va llenando una colección y la devuelve: se ve crecer vuelta a vuelta. */
export interface BuildRule extends Applied {
  kind: 'build'
  /** Cómo estaba tras cada paso (los primeros y el último, si son muchos). */
  steps: string[][]
  /** Cuántos pasos no se enseñan, entre el penúltimo que se ve y el último. */
  skipped: number
}

/** Devuelve lo que recibió con unos pocos elementos cambiados (una mutación, una corrección). */
export interface TweakRule extends Applied {
  kind: 'tweak'
  cells: string[]
  out: string[]
  /** Qué posiciones no son como entraron. */
  changed: boolean[]
}

export type Mechanism = MixRule | MatchRule | PodiumRule | BuildRule | TweakRule

/** Un texto de Python sin sus comillas. */
const unquoted = (text: string) => (/^(["']).*\1$/s.test(text) ? text.slice(1, -1) : text)

const plain = (value: Value): string =>
  value.kind === 'atom' ? unquoted(value.text) : showValue(value)

/**
 * Los elementos de una secuencia, como textos: los de una lista o una tupla de valores sueltos, o las letras
 * de un texto. `null` si no es una secuencia que se pueda mirar elemento a elemento (o no está entera).
 */
export function cellsOf(value: Value | undefined): string[] | null {
  if (!value) return null
  if (value.kind === 'atom' && value.type === 'text') {
    const text = unquoted(value.text)
    return text.length >= 2 && !text.includes('\\') ? [...text] : null
  }
  if (value.kind !== 'list' || value.more || value.shape === 'set') return null
  if (value.items.length < 2 || !value.items.every((item) => item.kind === 'atom')) return null
  return value.items.map(plain)
}

/** Los elementos de una colección cualquiera (también de listas o de textos): para saber si uno está en ella. */
const membersOf = (value: Value | undefined): string[] | null =>
  value?.kind === 'list' && !value.more && value.shape !== 'set' && value.items.length >= 2
    ? value.items.map((item) => showValue(item))
    : null

const numberOf = (value: Value | undefined): number | null =>
  value?.kind === 'atom' && value.type === 'number' && Number.isFinite(Number(value.text))
    ? Number(value.text)
    : null

/** Todo lo que la función tiene delante: lo que recibe y lo que lee del programa. */
const within = (sample: Sample) => [
  ...sample.inputs.map((input) => ({ ...input, hidden: false })),
  ...(sample.reads ?? []).map((read) => ({ ...read, hidden: true })),
]

/**
 * Una mezcla: lo que devuelve tiene el largo de dos de sus entradas y, posición a posición, lo de una o lo de
 * la otra. Tienen que aportar las dos (si no, es una copia), y lo que no viene de ninguna (una mutación) ha de
 * ser poco: si es mucho, no es una mezcla.
 */
function mixRules(sample: Sample): MixRule[] {
  const out = cellsOf(sample.returned)
  if (!out || out.length < 3) return []
  const rows = sample.inputs.flatMap((input) => {
    const cells = cellsOf(input.value)
    return cells && cells.length === out.length ? [{ name: input.name, cells }] : []
  })
  const [a, b] = rows
  if (!a || !b || rows.length !== 2) return []
  const from = out.map((cell, at): Origin => {
    const inA = a.cells[at] === cell
    const inB = b.cells[at] === cell
    return inA && inB ? 'both' : inA ? 'a' : inB ? 'b' : 'new'
  })
  const count = (origin: Origin) => from.filter((found) => found === origin).length
  if (count('a') === 0 || count('b') === 0) return []
  if (count('new') > Math.max(1, Math.floor(out.length * 0.2))) return []
  return [{ kind: 'mix', input: a.name, a, b, out, from }]
}

/**
 * Una comparación con un objetivo: devuelve un número que es justo cuántas posiciones de una entrada coinciden
 * (o cuántas no) con las de otra secuencia de su mismo largo: otra entrada, o algo del programa que lee sin
 * recibirlo. El código tiene que comparar de verdad (`==` o `!=`): un número que cuadra por casualidad no vale.
 */
function matchRules(code: string, sample: Sample): MatchRule[] {
  const total = numberOf(sample.returned)
  if (total === null || !Number.isInteger(total) || total < 0) return []
  const body = code.replace(/"[^"\n]*"|'[^'\n]*'/g, '""').replace(/#.*$/gm, '')
  const equal = /[^=!<>]==[^=]/.test(body)
  const unequal = /!=/.test(body)
  if (!equal && !unequal) return []
  const found: MatchRule[] = []
  const rows = within(sample).flatMap((entry) => {
    const cells = cellsOf(entry.value)
    return cells ? [{ ...entry, cells }] : []
  })
  for (const subject of rows.filter((row) => !row.hidden)) {
    for (const target of rows) {
      if (target.name === subject.name || target.cells.length !== subject.cells.length) continue
      // Entre dos entradas, cada pareja una sola vez.
      if (!target.hidden && target.name < subject.name) continue
      const hits = subject.cells.map((cell, at) => cell === target.cells[at])
      const same = hits.filter(Boolean).length
      const counts =
        equal && same === total
          ? 'same'
          : unequal && hits.length - same === total
            ? 'different'
            : null
      if (counts === null) continue
      found.push({
        kind: 'match',
        input: subject.name,
        cells: subject.cells,
        target: { name: target.name, cells: target.cells, hidden: target.hidden },
        hits,
        counts,
      })
    }
  }
  return found
}

/**
 * Un podio: devuelve algunos de los elementos de una lista que recibe (uno solo, o varios en una lista o una
 * tupla), y son justo los de mejor nota (o los de peor): la suya, si son números, o la de otra lista del mismo
 * largo. Tiene que haber alguien que se quede fuera con peor nota: si no, no hay nada que ganar.
 */
function podiumRules(sample: Sample): PodiumRule[] {
  const { returned } = sample
  if (!returned) return []
  const picked =
    returned.kind === 'list' && !returned.more
      ? returned.items.map((item) => showValue(item))
      : [showValue(returned)]
  if (picked.length === 0) return []
  const found: PodiumRule[] = []
  for (const input of sample.inputs) {
    const members = membersOf(input.value)
    if (!members || picked.length >= members.length) continue
    const numbers = (value: Value | undefined) =>
      value?.kind === 'list' && !value.more && value.items.length === members.length
        ? value.items.map(numberOf)
        : null
    // Las notas: las suyas (si son números), las de otra entrada, o las que la función calculó dentro.
    const boards = [
      { name: null as string | null, values: numbers(input.value) },
      ...[...sample.inputs, ...(sample.made ?? [])]
        .filter((other) => other.name !== input.name)
        .map((other) => ({ name: other.name as string | null, values: numbers(other.value) })),
    ]
    for (const board of boards) {
      const scores = board.values
      if (!scores || scores.some((score) => score === null)) continue
      const marks = scores as number[]
      for (const order of ['max', 'min'] as const) {
        const better = (x: number, y: number) => (order === 'max' ? x > y : x < y)
        // A cada elegido, su sitio en la lista: entre los iguales que queden, el de mejor nota.
        const taken = new Set<number>()
        const places: (number | null)[] = members.map(() => null)
        let valid = true
        for (const [place, text] of picked.entries()) {
          let best = -1
          for (const [at, member] of members.entries()) {
            if (member !== text || taken.has(at)) continue
            if (best < 0 || better(marks[at] ?? 0, marks[best] ?? 0)) best = at
          }
          if (best < 0) {
            valid = false
            break
          }
          taken.add(best)
          places[best] = place + 1
        }
        if (!valid) continue
        const chosen = [...taken].map((at) => marks[at] ?? 0)
        const others = marks.filter((_, at) => !taken.has(at))
        // Ninguno de fuera es mejor que uno de dentro, y alguno es peor.
        const worst = chosen.reduce((x, y) => (better(x, y) ? y : x))
        if (others.some((score) => better(score, worst))) continue
        if (!others.some((score) => better(worst, score))) continue
        // Y entre los elegidos, del mejor al peor (o no dice nada de su orden: vale igual).
        found.push({
          kind: 'podium',
          input: input.name,
          scores: board.name,
          order,
          ranked: members.map((text, at) => ({
            text,
            score: String(marks[at] ?? ''),
            place: places[at] ?? null,
          })),
        })
        break
      }
    }
  }
  return found
}

/**
 * Un retoque: devuelve una secuencia del largo de la única que recibe, igual salvo en unas pocas posiciones.
 * Algo tiene que cambiar (si no, es una copia) y no más de la mitad (si no, es otra cosa).
 */
function tweakRules(sample: Sample): TweakRule[] {
  const out = cellsOf(sample.returned)
  if (!out || out.length < 3) return []
  const rows = sample.inputs.flatMap((input) => {
    const cells = cellsOf(input.value)
    return cells && cells.length === out.length ? [{ name: input.name, cells }] : []
  })
  const [only] = rows
  if (!only || rows.length !== 1) return []
  const changed = out.map((cell, at) => only.cells[at] !== cell)
  const count = changed.filter(Boolean).length
  if (count === 0 || count > Math.floor(out.length / 2)) return []
  return [{ kind: 'tweak', input: only.name, cells: only.cells, out, changed }]
}

/** Cuántos estados de una colección que crece se enseñan: los primeros y el último. */
const MAX_BUILD = 5

/**
 * Una colección que se va llenando: una lista de la función que crece paso a paso hasta ser lo que devuelve.
 * Sale de la traza (cómo estaba la lista cada vez que cambió), no de leer el código.
 */
function buildRules(sample: Sample): BuildRule[] {
  const { built } = sample
  if (!built || built.steps.length < 3) return []
  const steps = built.steps.map((step) => (step.kind === 'list' ? step.items.map(plain) : null))
  if (steps.some((step) => step === null)) return []
  const lists = steps as string[][]
  // Crece siempre, y sin tocar lo que ya tenía.
  const grows = lists.every((list, at) => {
    const before = lists[at - 1]
    return !before || (list.length > before.length && before.every((cell, k) => list[k] === cell))
  })
  if (!grows) return []
  const shown =
    lists.length <= MAX_BUILD ? lists : [...lists.slice(0, MAX_BUILD - 1), ...lists.slice(-1)]
  return [
    {
      kind: 'build',
      input: built.name,
      steps: shown,
      skipped: lists.length - shown.length,
    },
  ]
}

/** Los mecanismos que la muestra confirma, del más concreto al menos. */
export function verifiedMechanisms(code: string, sample: Sample): Mechanism[] {
  if (sample.error !== undefined) return []
  return [
    ...matchRules(code, sample),
    ...mixRules(sample),
    ...podiumRules(sample),
    ...tweakRules(sample),
    ...buildRules(sample),
  ]
}

/** El mecanismo dicho en una frase: lo que se le da a elegir al JEV. */
export function mechanismSays(rule: Mechanism): string {
  if (rule.kind === 'mix')
    return `Mezcla ${rule.a.name} y ${rule.b.name}: cada posición del resultado viene de uno de los dos.`
  if (rule.kind === 'match')
    return `Compara ${rule.input} con ${rule.target.name} posición a posición y cuenta las que ${rule.counts === 'same' ? 'coinciden' : 'no coinciden'}.`
  if (rule.kind === 'podium')
    return `Se queda con ${rule.order === 'max' ? 'los de mayor' : 'los de menor'} valor${rule.scores ? ` según ${rule.scores}` : ''}.`
  if (rule.kind === 'tweak') return `Devuelve ${rule.input} con unos pocos elementos cambiados.`
  return `Va llenando ${rule.input} paso a paso y la devuelve.`
}
