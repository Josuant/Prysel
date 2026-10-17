import type { AiProvider } from '../ai/provider.ts'
import type { Decider } from '../jev/client.ts'
import type { Probe, ProbeValue } from '../trace.ts'

/**
 * **Cómo avanza** un programa, vuelta a vuelta. Lo que da al final lo dice su resultado; esto es lo de en
 * medio: lo mejor que lleva encontrado en cada vuelta de su bucle principal (una frase que se va pareciendo
 * a la que busca, un tablero que se va llenando) y un número que mide cómo de bien va (su puntuación, su
 * error).
 *
 * Qué mirar no es lo mismo en cada programa, así que se decide para cada uno:
 *
 * - La IA **propone** unas expresiones que mirar (`max(poblacion, key=puntuar)`), y les pone nombre. Además
 *   se prueban, sin IA, las variables que el propio bucle va cambiando.
 * - El motor las **mide de verdad**, ejecutando el programa: lo que valió cada una en cada vuelta. Las que no
 *   se pueden evaluar, o no cambian, se descartan; y si mirar cambiara lo que el programa da, no se enseña nada.
 * - El JEV **elige**, entre las que quedan, cuál cuenta mejor el avance.
 *
 * Lo que se dibuja son esas medidas: ni la IA ni el JEV ponen un solo valor.
 */

/** Algo que mirar en cada vuelta: la expresión y cómo se llama para quien lo lee. */
export interface Watch {
  expr: string
  says: string
  /** La propuso la IA (si no, es una variable del bucle, tal cual). */
  proposed?: boolean
}

export interface Progress {
  /** La línea del bucle que se miró, y las veces que se pasó por su cabecera. */
  line: number
  total: number
  /** Lo que quien lo usa pidió ver («cuántas letras acierta el peor»), si esto responde a ello. */
  wish?: string
  /** Algo que se lee, y cómo fue cambiando: lo que valía al empezar esas vueltas. */
  text?: { says: string; expr: string; laps: number[]; values: string[] }
  /** O una lista corta de números (se dibuja como barras), en esas vueltas. */
  bars?: { says: string; expr: string; laps: number[]; values: number[][] }
  /** O un tablero (se dibuja como rejilla): sus filas de casillas, en esas vueltas. */
  grid?: { says: string; expr: string; laps: number[]; values: (string | number)[][][] }
  /** Un número que mide cómo va. */
  number?: { says: string; expr: string; laps: number[]; values: number[] }
}

/** Cuántas expresiones se miran a la vez (el motor admite seis). */
export const MAX_WATCHES = 6

/** Las variables que el bucle va cambiando: lo que se puede mirar sin que nadie proponga nada. */
export function autoWatches(source: string, loop: { line: number; lineEnd: number }): Watch[] {
  const rows = source.split('\n').slice(loop.line, loop.lineEnd)
  const names: string[] = []
  for (const row of rows) {
    const assigned = /^\s+([A-Za-z_]\w*)\s*(?:[+\-*/]?=)(?!=)/.exec(row)
    const name = assigned?.[1]
    if (name && !names.includes(name)) names.push(name)
  }
  return names.slice(0, 3).map((name) => ({ expr: name, says: name.replace(/_+/g, ' ') }))
}

export function watchSystem(): string {
  return [
    'Eres parte de una herramienta que enseña cómo funciona un programa en Python mientras se ejecuta.',
    'Te doy un programa y su bucle principal. Propón hasta 4 expresiones de Python que, evaluadas AL EMPEZAR CADA VUELTA de ese bucle, enseñen cómo va avanzando hacia su resultado:',
    '- lo mejor que lleva encontrado, o lo que va construyendo, como un valor que se pueda VER: un texto, una lista corta de números (la que se ordena), o un tablero como lista de filas (el que va cambiando);',
    '- un NÚMERO que mida cómo de bien va (una puntuación, un error, un total). Un contador de vueltas no vale.',
    'Reglas: son expresiones, no sentencias (nada de asignar). Pueden usar las variables que existen en ese punto del programa, sus propias funciones si solo calculan (ni imprimen, ni cambian nada, ni usan el azar), y max, min, sum, len, sorted, round, abs. Nada de print, input ni import.',
    'Una por línea, con este formato exacto: expresión ## nombre',
    'El nombre va en español, de 2 a 4 palabras, sin código: «la mejor frase», «su puntuación».',
    'Sin explicaciones ni nada más.',
  ].join('\n')
}

export function watchPrompt(
  source: string,
  loop: { line: number; head: string },
  changing: readonly string[],
  /** Lo que quien lo usa quiere ver en cada vuelta, con sus palabras. */
  wish?: string,
): string {
  return [
    'El programa:',
    '```python',
    source.trimEnd(),
    '```',
    `Su bucle principal (línea ${loop.line}): ${loop.head}`,
    changing.length > 0 ? `Variables que va cambiando: ${changing.join(', ')}` : '',
    wish
      ? `Quien lo usa quiere ver, vuelta a vuelta, esto: «${wish}». Propón las expresiones que lo enseñen (primero la que mejor lo haga; si pide algo que se ve y también un número, las dos).`
      : '',
  ]
    .filter((row) => row !== '')
    .join('\n')
}

/** Si una expresión tiene pinta de valer, antes de dársela al motor (que la revisa de verdad). */
export function plausibleWatch(expr: string): boolean {
  if (expr.length === 0 || expr.length > 160 || expr.includes('\n')) return false
  return !/[;]|__|\b(import|print|input|open|exec|eval)\b/.test(expr)
}

/** Lo que propuso la IA: una expresión y su nombre por línea. Lo que no tenga esa forma, fuera. */
export function parseWatches(answer: string): Watch[] {
  const found: Watch[] = []
  for (const raw of answer.split('\n')) {
    const row = raw
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
      .replace(/`/g, '')
      .trim()
    const at = row.lastIndexOf('##')
    if (at <= 0) continue
    const expr = row.slice(0, at).trim()
    const says = row
      .slice(at + 2)
      .replace(/[«»"']/g, '')
      .trim()
      .toLowerCase()
    if (!plausibleWatch(expr) || says === '' || says.length > 40) continue
    if (found.some((one) => one.expr === expr)) continue
    found.push({ expr, says, proposed: true })
    if (found.length >= 4) break
  }
  return found
}

/** Pide a la IA qué mirar. `[]`: no propuso nada que valga. */
export async function proposeWatches(
  provider: AiProvider,
  source: string,
  loop: { line: number; head: string },
  changing: readonly string[],
  wish?: string,
): Promise<Watch[]> {
  const answer = await provider
    .generate({
      system: watchSystem(),
      prompt: watchPrompt(source, loop, changing, wish),
      maxTokens: 220,
    })
    .catch(() => '')
  return parseWatches(answer)
}

/** Lo que se midió de una expresión: sus valores (sin las vueltas en las que aún no se podía mirar). */
export interface Measured {
  watch: Watch
  /**
   * Qué forma tiene lo medido: un texto (o algo que se lee escrito), un número, una lista corta de números
   * (se dibuja como barras) o un tablero (como rejilla).
   */
  kind: 'text' | 'number' | 'bars' | 'grid'
  laps: number[]
  /** Lo que valía, escrito: para leerlo, y para decirle al JEV de qué a qué fue. */
  texts: string[]
  numbers: number[]
  /** Con `bars`: la lista, en cada vuelta. Con `grid`: el tablero. */
  bars?: number[][]
  grids?: (string | number)[][][]
}

const textOf = (value: ProbeValue): string | null =>
  value === null
    ? null
    : typeof value === 'number'
      ? String(value)
      : 's' in value
        ? value.s
        : value.o

/**
 * De lo que midieron las sondas, lo que sirve para contar un avance: lo que se pudo mirar en dos vueltas o
 * más y **cambió**. Un número que solo cuenta las vueltas (sube de uno en uno) no cuenta nada: fuera.
 */
export function measuredOf(probe: Probe, watches: readonly Watch[]): Measured[] {
  const found: Measured[] = []
  for (const [at, name] of probe.names.entries()) {
    const watch = watches.find((one) => one.expr === name)
    const column = probe.values[at] ?? []
    if (!watch) continue
    const laps: number[] = []
    const texts: string[] = []
    const numbers: number[] = []
    const bars: number[][] = []
    const grids: (string | number)[][][] = []
    for (const [k, value] of column.entries()) {
      const text = textOf(value)
      const lap = probe.laps[k]
      if (value === null || text === null || lap === undefined) continue
      laps.push(lap)
      texts.push(text)
      if (typeof value === 'number') numbers.push(value)
      else if ('n' in value) bars.push(value.n)
      else if ('g' in value) grids.push(value.g)
    }
    if (laps.length < 2) continue
    // La forma vale si todas las muestras la tienen, y del mismo tamaño: si no, se lee como texto.
    const same = <T>(list: readonly T[], size: (one: T) => string) =>
      list.length === laps.length && new Set(list.map(size)).size === 1
    const kind: Measured['kind'] =
      numbers.length === laps.length
        ? 'number'
        : same(bars, (one) => String(one.length))
          ? 'bars'
          : same(grids, (one) => `${one.length}x${one[0]?.length ?? 0}`)
            ? 'grid'
            : 'text'
    // ¿Cambió? De una lista o un tablero se mira lo que llevan, no cómo se escriben (que puede ir recortado).
    const marks =
      kind === 'bars'
        ? bars.map((one) => one.join(','))
        : kind === 'grid'
          ? grids.map((one) => JSON.stringify(one))
          : texts
    if (new Set(marks).size < 2) continue
    if (kind === 'number') {
      const counts = numbers.every(
        (value, k) =>
          k === 0 || value - (numbers[k - 1] ?? 0) === (laps[k] ?? 0) - (laps[k - 1] ?? 0),
      )
      if (counts) continue
    }
    found.push({
      watch,
      kind,
      laps,
      texts,
      numbers,
      ...(kind === 'bars' ? { bars } : {}),
      ...(kind === 'grid' ? { grids } : {}),
    })
  }
  return found
}

const clipped = (text: string, limit = 36) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text

/** Con cuánta certeza del JEV se toma su elección. */
const PICK_THRESHOLD = 0.5

/**
 * Entre lo medido, qué cuenta mejor el avance: algo que leer y un número. Lo decide el JEV viendo de cada
 * candidato su nombre, su expresión y de qué valor a qué valor fue. Si no contesta (o duda), queda lo
 * primero que propuso la IA; de lo que nadie propuso (una variable suelta del bucle), solo lo que se dibuja
 * solo: un número, una lista de números o un tablero.
 */
export async function pickWatches(
  decider: Decider,
  head: string,
  measured: readonly Measured[],
): Promise<{ text: Measured | null; number: Measured | null }> {
  // Lo que se ve (un texto, una lista, un tablero) compite entre sí; los números, entre ellos.
  const texts = measured.filter((one) => one.kind !== 'number')
  const numbers = measured.filter((one) => one.kind === 'number')
  const fallback = {
    // (Una lista o un tablero se dibujan: se ven aunque nadie los haya propuesto. Un texto suelto, no.)
    text:
      texts.find((one) => one.watch.proposed) ??
      texts.find((one) => one.kind === 'bars' || one.kind === 'grid') ??
      null,
    number: numbers.find((one) => one.watch.proposed) ?? numbers[0] ?? null,
  }
  if (texts.length + numbers.length === 0) return fallback
  const said = (one: Measured) =>
    `«${one.watch.says}» (${one.watch.expr}): de «${clipped(one.texts[0] ?? '')}» a «${clipped(one.texts[one.texts.length - 1] ?? '')}»`
  const options = (list: readonly Measured[], none: string) => ({
    ...Object.fromEntries(list.map((one, at) => [`c${at}`, said(one)])),
    ninguno: none,
  })
  try {
    const { answers } = await decider.decide({
      state: { bucle: head },
      questions: {
        ...(texts.length > 0
          ? {
              texto: {
                type: 'choice' as const,
                instructions:
                  'Un programa repite el `bucle`. De cada candidato se sabe lo que valía en la primera vuelta y en la última. ¿Cuál enseña mejor, VIÉNDOLO vuelta a vuelta, cómo el programa se va acercando a su resultado (lo mejor que lleva encontrado, lo que va construyendo, la lista que se ordena, el tablero que cambia)?',
                criteria: options(
                  texts,
                  'Ninguno deja ver un avance: son datos de paso, o colecciones enteras que no se leen.',
                ),
              },
            }
          : {}),
        ...(numbers.length > 0
          ? {
              numero: {
                type: 'choice' as const,
                instructions:
                  'Un programa repite el `bucle`. De cada candidato se sabe lo que valía en la primera vuelta y en la última. ¿Qué NÚMERO mide mejor cómo de bien va el programa, o cómo de cerca está de lo que busca (una puntuación, un error, un total que crece)?',
                criteria: options(
                  numbers,
                  'Ninguno mide el avance: son contadores, índices o números de paso.',
                ),
              },
            }
          : {}),
      },
    })
    const chosen = (answer: (typeof answers)[string] | undefined, list: readonly Measured[]) => {
      if (answer?.type !== 'choice' || answer.confidence < PICK_THRESHOLD) return undefined
      if (answer.choice === 'ninguno') return null
      return list[Number(answer.choice.slice(1))] ?? undefined
    }
    const text = chosen(answers['texto'], texts)
    const number = chosen(answers['numero'], numbers)
    return {
      text: text === undefined ? fallback.text : text,
      number: number === undefined ? fallback.number : number,
    }
  } catch {
    return fallback
  }
}

/**
 * Lo que se enseña cuando quien lo usa **dijo qué quería ver**: de lo que la IA propuso para eso y se pudo
 * medir, lo primero que se ve y el primer número. No lo elige nadie más: lo pidió así. `null`: nada de lo
 * propuesto se pudo mirar (o no cambia).
 */
export function wishedWatches(
  measured: readonly Measured[],
): { text: Measured | null; number: Measured | null } | null {
  const proposed = measured.filter((one) => one.watch.proposed)
  const text = proposed.find((one) => one.kind !== 'number') ?? null
  const number = proposed.find((one) => one.kind === 'number') ?? null
  return text || number ? { text, number } : null
}

/** El avance, con lo que se eligió enseñar (`null`: no hay nada que contar). */
export function progressOf(
  probe: Probe,
  picked: { text: Measured | null; number: Measured | null },
): Progress | null {
  if (!picked.text && !picked.number) return null
  const seen = picked.text
  const head = seen ? { says: seen.watch.says, expr: seen.watch.expr, laps: seen.laps } : null
  return {
    line: probe.line,
    total: probe.total,
    // Lo que se ve, con su forma: barras, rejilla, o lo que se lee.
    ...(seen && head
      ? seen.kind === 'bars' && seen.bars
        ? { bars: { ...head, values: seen.bars } }
        : seen.kind === 'grid' && seen.grids
          ? { grid: { ...head, values: seen.grids } }
          : { text: { ...head, values: seen.texts } }
      : {}),
    ...(picked.number
      ? {
          number: {
            says: picked.number.watch.says,
            expr: picked.number.watch.expr,
            laps: picked.number.laps,
            values: picked.number.numbers,
          },
        }
      : {}),
  }
}
