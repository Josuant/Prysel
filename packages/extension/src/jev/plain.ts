import type { BuildStep, Stage } from './build.ts'
import type { Decider, JevAnswer, JevQuestion } from './client.ts'

/**
 * Pedir solo contenido. A la IA generativa no se le pide ningún formato —ni JSON, ni etiquetas—, porque
 * cada formato es una ocasión de fallar. Se le pide lo que sabe dar tal cual:
 *
 * - **una lista** («las partes de la explicación, una por línea»),
 * - **código** («el Python de esto», como lo escribiría en un archivo),
 * - **una frase** («explica este trozo»),
 * - **una fórmula** («la de esta función, en términos de x»).
 *
 * Todo lo demás —la estructura— se pone aquí o lo decide el JEV: el código se trocea por sentencias leyendo
 * su sangría, y de cada trozo el JEV dice a qué etapa del plan pertenece, si es seguro, cómo se enseña y si
 * merece una ayuda visual. Elegir entre opciones cerradas es justo lo que el JEV hace bien, y lo que un
 * modelo de texto hace mal cuando además tiene que acordarse de un formato.
 *
 * Lo que hay aquí es puro: lee texto que llega a trozos y arma las preguntas al JEV.
 */

// ───────────────────────── una lista: las etapas del plan ─────────────────────────

/** Lee una etapa de una línea de la lista. `null` si esa línea no es una etapa (vacía, una introducción). */
export function stageFromLine(line: string): Stage | null {
  const text = line
    .replace(/^\s*(?:[-*•–]|\d+[.)-]|#+)\s*/, '')
    .replace(/\*\*|__|`/g, '')
    .trim()
  // «Estas son las etapas:» presenta la lista, no es parte de ella.
  if (text === '' || /:$/.test(text)) return null
  // Si trae su explicación detrás del título, se separa por lo primero que las separe.
  const cut = /^(.{2,60}?)\s*(?::| [—–-] )\s*(.+)$/.exec(text)
  if (cut) return { title: tidy(cut[1] ?? ''), goal: (cut[2] ?? '').trim().slice(0, 300) }
  if (text.length <= 60) return { title: tidy(text), goal: '' }
  // Una frase larga sin separar: sus primeras palabras hacen de título, y toda ella lo explica.
  return { title: tidy(text.split(/\s+/).slice(0, 5).join(' ')), goal: text.slice(0, 300) }
}

const tidy = (title: string) => title.replace(/[:.\s]+$/, '').replace(/\s+/g, ' ')

/** Saca cosas de un texto que llega a trozos, línea a línea: cada línea, en cuanto se acaba. */
export class LineStream<T> {
  private buffer = ''

  constructor(private readonly read: (line: string) => T | null) {}

  push(delta: string): T[] {
    this.buffer += delta
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.flatMap((line) => this.read(line) ?? [])
  }

  end(): T[] {
    const rest = this.buffer
    this.buffer = ''
    return rest.trim() === '' ? [] : [this.read(rest)].flatMap((item) => item ?? [])
  }
}

// ───────────────────────── código: de un texto que llega, a sentencias ─────────────────────────

/** Un trozo del código: una sentencia de primer nivel entera (con su cuerpo, si es compuesta). */
export interface Chunk {
  /** Su texto, sin sangría inicial. */
  code: string
  /**
   * Cómo se escribe: pieza a pieza (`steps`: cada línea, un paso con su nivel) si su forma lo permite, o de
   * una vez (`steps` con un solo paso) si lleva construcciones que no se arman por partes (`try`, `elif`…).
   */
  steps: BuildStep[]
}

const indentOf = (line: string) => line.length - line.trimStart().length

/** Las cláusulas que siguen a una sentencia compuesta a su misma altura: son parte de ella. */
const CLAUSE = /^(else|elif|except|finally|case)\b/
/** Lo que no se arma línea a línea: se escribe entero. */
const WHOLE = /^(elif|try|except|finally|match|case|class|async|@|lambda)\b|^@/

/** ¿Deja la línea algo abierto (un paréntesis, una cadena de tres comillas, una barra al final)? */
function unfinished(text: string): boolean {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    if (quote) {
      if (char === '\\') i++
      else if (text.startsWith(quote, i)) {
        i += quote.length - 1
        quote = null
      }
      continue
    }
    if (char === '#') {
      // Un comentario llega hasta el final de su línea.
      const end = text.indexOf('\n', i)
      if (end < 0) break
      i = end
    } else if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      quote = text.slice(i, i + 3)
      i += 2
    } else if (char === '"' || char === "'") quote = char
    else if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) depth--
  }
  // Una cadena de una comilla no pasa de línea: si quedó abierta, es un error del texto, no una espera.
  return depth > 0 || quote === '"""' || quote === "'''" || /\\\s*$/.test(text)
}

/** Las líneas de una sentencia, como pasos: cada una con su nivel, según su sangría. */
function stepsOf(lines: readonly string[]): BuildStep[] {
  const base = indentOf(lines.find((line) => line.trim() !== '') ?? '')
  // Las líneas lógicas: una sentencia que ocupa varias (un paréntesis abierto) es una sola pieza. De cada
  // una se recuerda en qué fila empieza.
  const logical: string[] = []
  const rows: number[] = []
  lines.forEach((line, row) => {
    const last = logical[logical.length - 1]
    if (last !== undefined && unfinished(last)) logical[logical.length - 1] = `${last}\n${line}`
    else if (line.trim() !== '') {
      logical.push(line)
      rows.push(row)
    }
  })
  const whole = (): BuildStep[] => {
    const first = rows[logical.findIndex((line) => !line.trimStart().startsWith('#'))] ?? 0
    return [
      {
        level: 0,
        code: lines.map((line) => line.slice(Math.min(base, indentOf(line))).trimEnd()).join('\n'),
        say: '',
        whole: true,
        // Sus partes, para explicarlo rama a rama: cada sentencia de dentro, menos lo que solo abre un
        // camino sin decir nada (`else:`, `finally:`).
        parts: logical.flatMap((line, index) => {
          const text = line.trim()
          return text.startsWith('#') || /^(else|finally)\s*:$/.test(text)
            ? []
            : [{ offset: (rows[index] ?? 0) - first, code: text }]
        }),
      },
    ]
  }
  if (logical.some((line) => WHOLE.test(line.trimStart()))) return whole()
  const stack: number[] = []
  const steps: BuildStep[] = []
  let comment: string[] = []
  for (const line of logical) {
    const indent = indentOf(line)
    const text = line
      .split('\n')
      .map((row, i) => (i === 0 ? row.trimStart() : row.slice(Math.min(indent, indentOf(row)))))
      .join('\n')
      .trimEnd()
    // Un comentario va con la sentencia que tiene debajo.
    if (text.startsWith('#')) {
      comment.push(text)
      continue
    }
    while (stack.length > 0 && indent <= (stack[stack.length - 1] ?? 0)) stack.pop()
    // Un `else:` cierra el cuerpo de su `if` y va a su misma altura.
    steps.push({ level: stack.length, code: [...comment, text].join('\n'), say: '' })
    comment = []
    if (/:\s*(#.*)?$/.test(text.split('\n').pop() ?? '') && !text.includes('\n')) stack.push(indent)
  }
  return steps
}

/**
 * Lee código Python que llega a trozos y entrega cada sentencia de primer nivel en cuanto está completa:
 * una sencilla, al acabar su línea; una compuesta, cuando llega la siguiente (o se acaba el texto). Las
 * vallas de código y los comentarios sueltos no cuentan como sentencias (el comentario va con la siguiente).
 */
export class CodeStream {
  private buffer = ''
  private lines: string[] = []
  private base: number | null = null
  private fenced = false
  /** La sentencia que se está leyendo es, de momento, una sola línea lógica. */
  private single = false

  private flush(): Chunk[] {
    const lines = this.lines
    this.lines = []
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()
    // Solo comentarios: esperan a su sentencia.
    if (lines.every((line) => line.trim() === '' || line.trimStart().startsWith('#'))) {
      this.lines = lines
      return []
    }
    const base = indentOf(lines.find((line) => line.trim() !== '') ?? '')
    const steps = stepsOf(lines)
    if (steps.length === 0) return []
    return [
      {
        code: lines.map((line) => line.slice(Math.min(base, indentOf(line))).trimEnd()).join('\n'),
        steps,
      },
    ]
  }

  /** Las líneas de código (no comentarios ni blancos) de la sentencia que se está leyendo. */
  private code(): string[] {
    return this.lines.filter((row) => row.trim() !== '' && !row.trimStart().startsWith('#'))
  }

  private take(raw: string): Chunk[] {
    const line = raw.replace(/\r$/, '').replace(/\t/g, '    ')
    if (/^\s*```/.test(line)) {
      this.fenced = true
      return []
    }
    if (line.trim() === '') {
      if (this.lines.length > 0) this.lines.push('')
      return []
    }
    const code = this.code()
    // Dentro de algo abierto (un paréntesis, tres comillas), la línea sigue a la anterior, sea cual sea su sangría.
    if (code.length > 0 && unfinished(code.join('\n'))) {
      this.lines.push(line)
      const text = this.code().join('\n')
      // Una sentencia sencilla que ocupaba varias líneas ya está entera.
      return this.single && !unfinished(text) && !/:\s*(#.*)?$/.test(text) ? this.flush() : []
    }
    this.base ??= indentOf(line)
    const top = indentOf(line) <= this.base
    const text = line.trimStart()
    const found: Chunk[] = []
    // Una línea a la altura de partida empieza otra sentencia, salvo que sea una cláusula de la anterior
    // (`else:`, `except:`) o que lo anterior fueran solo decoradores.
    const decorated = code.length > 0 && code.every((row) => row.trimStart().startsWith('@'))
    if (top && code.length > 0 && !CLAUSE.test(text) && !decorated) found.push(...this.flush())
    if (top && !text.startsWith('#')) this.single = this.code().length === 0
    else if (!text.startsWith('#')) this.single = false
    this.lines.push(line)
    // Una sentencia sencilla (una línea, sin cuerpo) ya está completa: no hace falta esperar a la siguiente.
    if (
      top &&
      this.single &&
      !text.startsWith('#') &&
      !text.startsWith('@') &&
      !unfinished(line) &&
      !/:\s*(#.*)?$/.test(text)
    ) {
      found.push(...this.flush())
    }
    return found
  }

  push(delta: string): Chunk[] {
    this.buffer += delta
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.flatMap((line) => this.take(line))
  }

  end(): Chunk[] {
    const found = this.buffer === '' ? [] : this.take(this.buffer)
    this.buffer = ''
    return [...found, ...this.flush()]
  }

  /** Si la respuesta traía vallas de código (lo de fuera de ellas es conversación, no código). */
  get hadFences(): boolean {
    return this.fenced
  }
}

// ───────────────────────── una frase, una fórmula ─────────────────────────

/** Una frase tal como la devuelve un modelo, lista para decirla: sin comillas, marcas ni saltos. */
export function sentenceOf(text: string, max = 300): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'«“]+|["'»”]+$/g, '')
    .slice(0, max)
}

/** Una fórmula tal como la devuelve un modelo: su primera línea, sin el «y =» ni adornos. */
export function formulaOf(text: string): string {
  const line =
    text
      .replace(/```\w*/g, '')
      .split('\n')
      .map((row) => row.trim())
      .find((row) => row !== '') ?? ''
  return line
    .replace(/`|\$/g, '')
    .replace(/^(?:y|f\(x\))\s*=\s*/i, '')
    .trim()
    .slice(0, 120)
}

// ───────────────────────── lo que decide el JEV de cada trozo ─────────────────────────

/** Los rangos de x entre los que el JEV elige para dibujar una curva. */
export const RANGES: Record<string, [number, number]> = {
  'de -6 a 6': [-6, 6],
  'de -1 a 1': [-1, 1],
  'de 0 a 1': [0, 1],
  'de 0 a 10': [0, 10],
  'de 0 a 100': [0, 100],
}

export const CHUNK_THRESHOLDS = {
  safe: 0.7,
  /** Por debajo, no está claro a qué etapa va el trozo: se queda en la que se estaba. */
  stage: 0.4,
  staging: 0.5,
  /** A partir de aquí, el trozo merece una ayuda visual. */
  aid: 0.6,
} as const

export interface ChunkVerdict {
  safe: number
  /** La etapa del plan a la que pertenece (su índice), si el JEV lo tiene claro. */
  stage: number | null
  wide: boolean
  pause: boolean
  /** Merece que se dibuje su fórmula, y entre qué valores de x. */
  aid: [number, number] | null
  ms: number
}

/** Lo que se le pregunta al JEV de un trozo de código: todo a la vez, en una petición. */
export function chunkQuestions(
  stages: readonly Stage[],
  withAid: boolean,
): Record<string, JevQuestion> {
  return {
    seguro: {
      type: 'noul',
      instructions:
        'El campo `codigo` es Python que se va a añadir a un programa para cumplir la `orden`. ¿Se puede escribir y ejecutar sin riesgo para el equipo de quien lo pidió?',
      criteria: {
        true: 'Solo calcula, guarda valores, define funciones o imprime; o toca archivos, la red o el sistema porque la orden lo pide expresamente.',
        false:
          'Borra o sobrescribe archivos, usa la red, lanza otros programas o ejecuta código dinámico sin que la orden lo pida.',
      },
    },
    ...(stages.length >= 2
      ? {
          etapa: {
            type: 'choice',
            instructions:
              'El programa se construye siguiendo un plan por etapas. ¿A qué etapa del plan pertenece este `codigo`?',
            criteria: Object.fromEntries(
              stages.map((stage, index) => [
                `e${index + 1}`,
                stage.goal ? `${stage.title}: ${stage.goal}` : stage.title,
              ]),
            ),
          } satisfies JevQuestion,
        }
      : {}),
    camara: {
      type: 'choice',
      instructions:
        'Al aparecer esta pieza en el diagrama, ¿qué conviene enseñar para que se entienda?',
      criteria: {
        acercar: 'La pieza sola, de cerca: es un dato o un paso que se entiende por sí mismo.',
        conjunto:
          'La pieza junto a lo que la rodea: abre un bloque (función, bucle, decisión), o usa lo que se definió antes y hay que ver la relación.',
      },
    },
    ritmo: {
      type: 'choice',
      instructions: '¿Cuánto hay que detenerse en esta pieza al explicarla?',
      criteria: {
        seguir: 'Es un paso sencillo o parecido al anterior: se sigue enseguida.',
        pausa:
          'Es una idea clave del programa (su función principal, su bucle, su decisión, su resultado): merece una pausa.',
      },
    },
    ...(withAid
      ? {
          ayuda: {
            type: 'noul',
            instructions:
              '¿Este `codigo` calcula una fórmula matemática de una sola variable que se entendería mejor viendo su curva?',
            criteria: {
              true: 'Es una función matemática de un número (una sigmoide, una ReLU, un cuadrado, un crecimiento, una probabilidad).',
              false:
                'No es una fórmula de una variable: maneja listas, textos, varios datos, o solo organiza pasos.',
            },
          } satisfies JevQuestion,
          rango: {
            type: 'choice',
            instructions:
              'Si se dibujara la curva de esa fórmula, ¿entre qué valores de x se vería mejor su forma?',
            criteria: Object.fromEntries(Object.keys(RANGES).map((range) => [range, null])),
          } satisfies JevQuestion,
        }
      : {}),
  }
}

export async function judgeChunk(
  decider: Decider,
  command: string,
  code: string,
  stages: readonly Stage[],
  written: string,
): Promise<ChunkVerdict> {
  const withAid = /^\s*def\b/m.test(code)
  const { answers, ms } = await decider.decide({
    state: {
      orden: command,
      codigo: code,
      ...(written ? { ya_escrito: written.slice(-1500) } : {}),
    },
    questions: chunkQuestions(stages, withAid),
  })
  const noul = (id: string, missing: number) => {
    const answer = answers[id]
    return answer?.type === 'noul' ? answer.noul : missing
  }
  const picked = (id: string, min: number) => {
    const answer = answers[id]
    return answer?.type === 'choice' && answer.confidence >= min ? answer.choice : null
  }
  const stage = /^e(\d+)$/.exec(picked('etapa', CHUNK_THRESHOLDS.stage) ?? '')?.[1]
  const range = RANGES[picked('rango', 0) ?? ''] ?? RANGES['de -6 a 6']
  return {
    safe: noul('seguro', 0),
    stage: stage === undefined ? null : Number(stage) - 1,
    wide: picked('camara', CHUNK_THRESHOLDS.staging) === 'conjunto',
    pause: picked('ritmo', CHUNK_THRESHOLDS.staging) === 'pausa',
    aid: withAid && noul('ayuda', 0) >= CHUNK_THRESHOLDS.aid && range ? range : null,
    ms,
  }
}

// ───────────────────────── subrayar: la parte exacta de la que habla una frase ─────────────────────────

const KEYWORDS = new Set(
  'and as assert break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(
    ' ',
  ),
)

/** Un trozo de una pieza que se podría subrayar, y qué es dentro de ella (es lo que lee el JEV). */
export interface Fragment {
  text: string
  what: string
}

/** Parte por las comas de fuera: las de dentro de un paréntesis, un corchete o un texto no cuentan. */
function splitTop(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let from = 0
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i] ?? ''
    if (quote !== '') {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) depth--
    else if (char === ',' && depth === 0) {
      parts.push(inner.slice(from, i))
      from = i + 1
    }
  }
  parts.push(inner.slice(from))
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** Dónde se cierra lo que se abre en `open` (un paréntesis o un corchete). -1 si no se cierra. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const char = text[i] ?? ''
    if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char) && --depth === 0) return i
  }
  return -1
}

/**
 * Los trozos de una pieza de código que se podrían subrayar al explicarla, cada uno con lo que es: la
 * condición, lo que se calcula, cada llamada (entera, su nombre y lo que recibe), los elementos de una
 * lista, los textos, los nombres y los números. Es el conjunto cerrado entre el que elige el JEV.
 */
export function partsOf(code: string, max = 16): Fragment[] {
  const line =
    code.split('\n').find((row) => row.trim() !== '' && !row.trimStart().startsWith('#')) ?? ''
  const text = line.replace(/#.*$/, '').trim()
  const found: Fragment[] = []
  const add = (fragment: string, what: string) => {
    const clean = fragment.trim()
    if (clean.length >= 1 && clean !== text && !found.some((item) => item.text === clean))
      found.push({ text: clean, what })
  }
  // Lo que la sentencia tiene de principal: lo que comprueba, lo que recorre, lo que calcula y dónde lo deja.
  const test = /^(?:if|elif|while)\s+(.+?):?$/.exec(text)
  const loop = /^for\s+(.+?)\s+in\s+(.+?):?$/.exec(text)
  const back = /^return\s+(.+)$/.exec(text)
  const kept = /^([A-Za-z_][\w.[\]]*)\s*(?:[-+*/%]|\/\/|\*\*)?=(?!=)\s*(.+)$/.exec(text)
  if (test) add(test[1] ?? '', 'la condición que se comprueba')
  else if (loop) {
    add(loop[1] ?? '', 'la variable que toma cada elemento')
    add(loop[2] ?? '', 'lo que se recorre')
  } else if (back) add(back[1] ?? '', 'lo que se devuelve')
  else if (kept) {
    add(kept[2] ?? '', 'el valor que se calcula')
    add(kept[1] ?? '', 'la variable donde se guarda')
  }
  // Las llamadas: primero el nombre de cada una —la operación—, que es de lo que suele hablar la frase
  // («lo pasamos a minúsculas» → `lower`); después enteras, de fuera adentro, y lo que recibe cada una.
  const calls: { whole: string; name: string; args: string[] }[] = []
  for (const match of text.matchAll(/[A-Za-z_][\w.]*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1
    const end = closing(text, open)
    if (end < 0) continue
    calls.push({
      whole: text.slice(match.index ?? 0, end + 1),
      name: match[0].slice(0, -1).split('.').pop() ?? '',
      args: splitTop(text.slice(open + 1, end)),
    })
  }
  for (const call of calls) add(call.name, 'la operación que se aplica')
  for (const call of calls) add(call.whole, `la llamada a ${call.name}, entera`)
  for (const call of calls) for (const arg of call.args) add(arg, `lo que recibe ${call.name}`)
  // Un elemento de una lista o de un diccionario: `notas[0]`.
  for (const match of text.matchAll(/[A-Za-z_][\w.]*\[/g)) {
    const end = closing(text, (match.index ?? 0) + match[0].length - 1)
    if (end >= 0)
      add(text.slice(match.index ?? 0, end + 1), `un elemento de ${match[0].slice(0, -1)}`)
  }
  for (const match of text.matchAll(/"[^"]*"|'[^']*'/g)) add(match[0], 'un texto')
  // Los nombres y los números, sin contar lo que va dentro de un texto entre comillas.
  const bare = text.replace(/"[^"]*"|'[^']*'/g, (quoted) => ' '.repeat(quoted.length))
  for (const match of bare.matchAll(/[A-Za-z_]\w*/g))
    if (!KEYWORDS.has(match[0])) add(match[0], 'un dato')
  for (const match of bare.matchAll(/\b\d+(?:\.\d+)?\b/g)) add(match[0], 'un número')
  return found.slice(0, max)
}

/** Solo los trozos, sin lo que son. */
export const fragmentsOf = (code: string, max?: number): string[] =>
  partsOf(code, max).map((part) => part.text)

/** Minúsculas y sin acentos: para comparar lo que se dice con lo que hay escrito. */
const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * Cómo se suele decir en voz alta lo que en Python tiene un nombre en inglés: el comienzo de las palabras
 * (sin acentos) que lo delatan. «Lo pasamos a minúsculas» habla de `lower` sin nombrarlo.
 */
const SPOKEN: Record<string, string[]> = {
  lower: ['minuscul'],
  upper: ['mayuscul'],
  capitalize: ['mayuscul', 'capital'],
  title: ['mayuscul', 'titulo'],
  strip: ['espacios', 'limpi', 'recort'],
  split: ['separ', 'divid', 'trocea', 'parti', 'palabras'],
  join: ['une ', 'unir', 'unimos', 'junta'],
  replace: ['reemplaz', 'sustitu', 'cambia'],
  startswith: ['empieza', 'comienza'],
  endswith: ['termina', 'acaba'],
  find: ['busca', 'encuentr'],
  count: ['cuenta', 'contamos', 'veces'],
  len: ['longitud', 'cuantos', 'cuantas', 'tamano', 'numero de', 'largo'],
  sum: ['suma'],
  abs: ['absolut'],
  max: ['maxim', 'mayor', 'mas alt', 'mas grande'],
  min: ['minim', 'menor', 'mas baj', 'mas pequen'],
  round: ['redonde'],
  sorted: ['orden'],
  sort: ['orden'],
  reversed: ['reves', 'invert', 'invier'],
  reverse: ['reves', 'invert', 'invier'],
  append: ['anad', 'agreg', 'al final', 'guardamos en la lista'],
  extend: ['anad', 'agreg', 'ampli'],
  insert: ['insert'],
  pop: ['saca', 'quita', 'extrae'],
  remove: ['quita', 'elimin', 'borra'],
  input: ['pregunt', 'pedimos', 'pide', 'escrib', 'teclado', 'usuario'],
  print: ['muestr', 'mostra', 'imprim', 'pantalla', 'ensena'],
  int: ['entero'],
  float: ['decimal'],
  str: ['a texto', 'en texto', 'cadena'],
  list: ['lista'],
  dict: ['diccionario'],
  set: ['conjunto', 'repetid'],
  range: ['rango', 'veces', 'desde', 'hasta'],
  enumerate: ['numera', 'posicion', 'indice'],
  zip: ['empareja', 'pareja', 'a la vez', 'junto con'],
  open: ['abr', 'archivo', 'fichero'],
  read: ['lee', 'leer', 'leemos'],
  write: ['escrib'],
  sqrt: ['raiz'],
  exp: ['exponencial'],
  random: ['azar', 'aleatori'],
  randint: ['azar', 'aleatori'],
  choice: ['azar', 'aleatori', 'elige', 'escoge'],
  shuffle: ['baraja', 'mezcla', 'desorden'],
  sleep: ['espera', 'pausa'],
  get: ['busca', 'consulta'],
  keys: ['claves'],
  values: ['valores'],
  items: ['pares'],
  isdigit: ['digito', 'numero'],
  any: ['alguno', 'alguna'],
  all: ['todos', 'todas'],
}

/**
 * De los trozos de una pieza, el que la frase delata por sí sola: una operación que nombra con otras
 * palabras («minúsculas» → `lower`), o un nombre, un número o un texto que dice tal cual. -1 si ninguno.
 * No sustituye al JEV: es lo que se usa cuando él no se decide.
 */
export function hinted(say: string, fragments: readonly string[]): number {
  const said = fold(say)
  if (said.trim() === '') return -1
  // El punto se queda dentro de un número (`1.0`), no al final de una palabra.
  const words = said.split(/[^a-z0-9_.]+/).map((word) => word.replace(/^\.+|\.+$/g, ''))
  const spoken = fragments.findIndex((fragment) =>
    (SPOKEN[fragment.toLowerCase()] ?? []).some((stem) => said.includes(stem)),
  )
  if (spoken >= 0) return spoken
  return fragments.findIndex((fragment) => {
    const text = fold(fragment)
    if (/^[a-z_]\w+$/.test(text) || /^\d+(\.\d+)?$/.test(text)) return words.includes(text)
    const quoted = /^["'](.{3,})["']$/.exec(text)?.[1]
    return quoted !== undefined && said.includes(quoted)
  })
}

/** A partir de aquí, el JEV tiene claro qué trozo subrayar. Elige entre muchos: no hace falta más. */
export const MARK_THRESHOLD = 0.3
/** Con esta seguridad de que la frase no habla de nada en concreto, no se subraya nada. */
export const NO_MARK_THRESHOLD = 0.7
/** Cuántos trozos se mandan al lienzo por frase: el elegido y sus suplentes, por si aquel no está a la vista. */
const MARK_CHOICES = 3

/**
 * Qué trozo exacto de cada pieza conviene subrayar mientras se dice su frase. Se pregunta por todas las
 * piezas a la vez; el JEV elige entre los trozos de cada una (o ninguno). Devuelve, por pieza, los trozos
 * por orden de preferencia (vacío: ninguno): el lienzo subraya el primero que encuentra escrito en el nodo,
 * que no enseña el código tal cual. Si el JEV no contesta o no se decide, vale lo que la frase delata sola.
 */
export async function judgeMarks(
  decider: Decider,
  pieces: readonly { code: string; say: string }[],
): Promise<{ marks: string[][]; ms: number }> {
  const options = pieces.map((piece) => (piece.say === '' ? [] : partsOf(piece.code)))
  const questions: Record<string, JevQuestion> = {}
  pieces.forEach((piece, index) => {
    const parts = options[index] ?? []
    if (parts.length === 0) return
    questions[`m${index + 1}`] = {
      type: 'choice',
      instructions: `Se va a decir en voz alta: «${piece.say}», mientras se enseña este código: ${piece.code.split('\n').find((row) => row.trim() !== '' && !row.trimStart().startsWith('#')) ?? ''}\n¿Qué trozo del código conviene subrayar mientras se dice? El que mejor corresponde a lo que la frase destaca, aunque lo diga con otras palabras: la operación («pasamos a minúsculas» es lower, «sumamos» es sum), el dato o el valor del que habla. Casi siempre hay uno.`,
      criteria: {
        ...Object.fromEntries(parts.map((part, i) => [`f${i + 1}`, `${part.text} — ${part.what}`])),
        ninguno: 'La frase no destaca ninguna parte: habla de la pieza entera.',
      },
    }
  })
  if (Object.keys(questions).length === 0) return { marks: pieces.map(() => []), ms: 0 }
  const { answers, ms } = await decider
    .decide({ state: {}, questions })
    .catch(() => ({ answers: {} as Record<string, JevAnswer>, ms: 0 }))
  return {
    ms,
    marks: pieces.map((piece, index) => {
      const texts = (options[index] ?? []).map((part) => part.text)
      if (texts.length === 0) return []
      const at = (option: string) => {
        const picked = /^f(\d+)$/.exec(option)?.[1]
        return picked === undefined ? undefined : texts[Number(picked) - 1]
      }
      const given = answers[`m${index + 1}`]
      const answer = given?.type === 'choice' ? given : undefined
      const choice = answer?.choice ?? ''
      const confidence = answer?.confidence ?? 0
      // Está seguro de que no hay nada que destacar: no se subraya.
      if (choice === 'ninguno' && confidence >= NO_MARK_THRESHOLD) return []
      const ranked: string[] = []
      const push = (text: string | undefined) => {
        if (text !== undefined && !ranked.includes(text)) ranked.push(text)
      }
      if (confidence >= MARK_THRESHOLD) push(at(choice))
      const hint = texts[hinted(piece.say, texts)]
      // Sin una elección clara, manda lo que la frase delata; con ella, queda de suplente.
      push(hint)
      if (ranked.length > 0)
        for (const [option, chance] of Object.entries(answer?.probabilities ?? {}).sort(
          (a, b) => b[1] - a[1],
        ))
          if (chance >= 0.1) push(at(option))
      return ranked.slice(0, MARK_CHOICES)
    }),
  }
}

// ───────────────────────── mientras se le oye: ¿qué está pidiendo? ─────────────────────────

/** Lo que el usuario puede estar pidiendo, por lo que lleva dicho. `nada`: aún no se sabe. */
export const HEARD_KINDS = [
  'funcion',
  'clase',
  'bucle',
  'decision',
  'variable',
  'lista',
  'programa',
  'cambio',
  'explicacion',
  'nada',
] as const
export type HeardKind = (typeof HEARD_KINDS)[number]

/**
 * El usuario está hablando y aún no ha terminado. Con lo que lleva dicho, el JEV dice qué clase de cosa
 * está pidiendo, para ir dibujando su hueco antes de que acabe la frase. Es barato (una pregunta cerrada) y
 * se repite con cada palabra nueva.
 */
export async function judgeHeard(
  decider: Decider,
  heard: string,
): Promise<{ kind: HeardKind; complete: number; ms: number }> {
  const { answers, ms } = await decider.decide({
    state: { oido: heard },
    questions: {
      // Quien habla hace pausas a mitad de frase: antes de dar lo dicho por una orden hay que saber si
      // ya está entera. Si no, se espera a lo que falta, en vez de cumplir media frase.
      completa: {
        type: 'noul',
        instructions:
          'El campo `oido` es lo que alguien lleva dicho. ¿Es ya una orden entera, que se puede cumplir tal cual, o la frase está a medias?',
        criteria: {
          true: 'Está entera: dice qué quiere y sobre qué. «Crea una clase llamada animal», «borra el objeto gato», «sí», «deshazlo».',
          false:
            'Está a medias: le falta lo principal, o acaba en una palabra que pide continuación (un artículo, una preposición, «que», «para», «y»). «Crea una», «un objeto», «en el programa principal», «manda llamar la función para», «y llamada gato».',
        },
      },
      oyendo: {
        type: 'choice',
        instructions:
          'El campo `oido` es lo que alguien lleva dicho de una orden para un programa en Python; aún no ha terminado la frase. Por lo que lleva dicho, ¿qué está pidiendo?',
        criteria: {
          funcion: 'Una función (o un método).',
          clase: 'Una clase.',
          bucle: 'Un bucle: repetir algo, recorrer algo.',
          decision: 'Una decisión: si pasa esto, hacer aquello.',
          variable: 'Una variable, un dato o una constante.',
          lista: 'Una lista, un diccionario u otra colección.',
          programa: 'Un programa, un algoritmo o un juego entero.',
          cambio: 'Cambiar, quitar o renombrar algo que ya hay.',
          explicacion: 'Que se le explique o se le enseñe algo.',
          nada: 'Todavía no se sabe: no ha dicho bastante.',
        },
      },
    },
  })
  const answer = answers.oyendo
  const kind =
    answer?.type === 'choice' && answer.confidence >= 0.4
      ? (HEARD_KINDS.find((id) => id === answer.choice) ?? 'nada')
      : 'nada'
  const whole = answers.completa
  return { kind, complete: whole?.type === 'noul' ? whole.noul : 1, ms }
}

// ───────────────────────── un paso de una orden larga: ¿ya está hecho? ─────────────────────────

/** Con cuánta certeza del JEV se da un paso por hecho y se sigue con el siguiente. */
export const DONE_THRESHOLD = 0.6

/**
 * Una orden larga se parte en pasos, y a veces un paso deja hecho también el siguiente («sácalo de la función»
 * ya lo deja en el programa; «ponlo en el programa» no tiene nada que mover). Antes de pararse en un paso que
 * no se sabe cómo cumplir, el JEV mira el programa tal como está y dice si eso ya está cumplido.
 */
export async function judgeDone(
  decider: Decider,
  step: string,
  code: string,
  earlier: readonly string[],
): Promise<number> {
  const { answers } = await decider.decide({
    state: { paso: step, programa: code, antes: [...earlier] },
    questions: {
      hecho: {
        type: 'noul',
        instructions:
          'El campo `programa` es un programa de Python tal como está ahora. `antes` son los pasos que se acaban de cumplir sobre él. El campo `paso` es el siguiente paso que se pidió. ¿Está ya cumplido ese `paso` en el programa, de modo que no queda nada por hacer para él?',
        criteria: {
          true: 'Sí: el programa ya está como pide el paso (lo dejó así un paso anterior, o ya estaba).',
          false: 'No: todavía falta hacer algo en el programa para cumplir el paso.',
        },
      },
    },
  })
  const answer = answers['hecho']
  return answer?.type === 'noul' ? answer.noul : 0
}

// ───────────────────────── si el usuario interrumpe: ¿vale lo que ya estaba preparado? ─────────────────────────

/** Qué hacer con una orden que llega mientras se está construyendo otra cosa. */
export type Interruption = 'seguir' | 'ajustar' | 'otra'

/**
 * El usuario dice algo mientras se construye. El JEV decide si lo que estaba preparado sigue valiendo
 * (`seguir`: no cambia nada), si hay que rehacer lo que faltaba teniendo en cuenta lo nuevo (`ajustar`), o si
 * es otra cosa distinta (`otra`: se deja lo que se estaba haciendo y se atiende). Con dudas, es `otra`: lo
 * que el usuario acaba de decir manda.
 */
export async function judgeInterruption(
  decider: Decider,
  request: { building: string; said: string; pending: string },
): Promise<{ what: Interruption; ms: number }> {
  const { answers, ms } = await decider.decide({
    state: {
      construyendo: request.building,
      nuevo: request.said,
      ...(request.pending ? { preparado_sin_escribir: request.pending.slice(0, 1500) } : {}),
    },
    questions: {
      interrupcion: {
        type: 'choice',
        instructions:
          'Se está construyendo un programa para cumplir `construyendo`, y hay código ya preparado que aún no se ha escrito. El usuario acaba de decir `nuevo`. ¿Qué hay que hacer con lo preparado?',
        criteria: {
          seguir:
            'Lo nuevo no cambia lo que se está construyendo: es un comentario, un ánimo, o algo que no pide nada distinto.',
          ajustar:
            'Lo nuevo corrige o matiza lo que se está construyendo: lo que falta hay que rehacerlo teniéndolo en cuenta.',
          otra: 'Lo nuevo es otra petición distinta: hay que dejar lo que se estaba haciendo y atenderla.',
        },
      },
    },
  })
  const answer = answers.interrupcion
  const what =
    answer?.type === 'choice' &&
    answer.confidence >= 0.5 &&
    (answer.choice === 'seguir' || answer.choice === 'ajustar')
      ? answer.choice
      : 'otra'
  return { what, ms }
}

// ───────────────────────── lo que se le pide a la IA: solo contenido ─────────────────────────

const TEACH =
  'El usuario no ha pedido un programa: quiere ENTENDER un tema. El programa es tu pizarra: un modelo pequeño que lo simule con datos de ejemplo, con nombres tomados del tema.'

export function planSystem(teach: boolean): string {
  return [
    teach
      ? `${TEACH} Piensa las partes de la EXPLICACIÓN (qué pasa primero, qué después), no partes de un programa cualquiera.`
      : 'Alguien te pide un programa en Python y tú lo vas a construir explicándolo. Antes de escribir nada, piensa el plan.',
    'Lista las partes por las que pasa, en orden, una por línea: un título de dos a cuatro palabras y, si quieres, detrás de dos puntos, qué ocurre en esa parte en menos de diez palabras.',
    'Entre 2 y 7 partes. Solo la lista: sin introducción, sin código y sin despedida.',
  ].join('\n')
}

export function codeSystem(teach: boolean): string {
  return [
    teach
      ? `${TEACH} Sé riguroso con el tema: no inventes datos; si usas valores aproximados, que sean razonables.`
      : 'Escribes un programa en Python que un editor va a dibujar como un diagrama, pieza a pieza.',
    'Escribe el código, y solo el código: Python tal cual iría en el archivo, sin explicaciones alrededor.',
    'Código claro, de principiante: nombres en español, sin trucos. Usa los nombres que ya existen cuando la orden se refiera a ellos, y no repitas lo que ya está en el programa.',
    teach
      ? 'Usa valores de ejemplo concretos, y enseña el resultado.'
      : 'Escribe EXACTAMENTE lo que se pide y nada más. Si se pide una clase, solo la clase (con su constructor y lo que la orden nombre): no le inventes métodos. Si se pide una función, solo la función. No añadas ejemplos de uso, llamadas de prueba ni print que la orden no pida: quien lo pidió irá diciendo lo siguiente.',
    'Cuando el cuerpo de una función (o el programa) tenga más de unos cinco pasos, agrúpalos por lo que pretenden: delante de cada grupo, una línea en blanco y un comentario corto que diga su intención con un verbo («# Aplicar la física», «# Comprobar choques», «# Guardar el resultado»). Al menos dos grupos, o ninguno. El editor dibuja cada grupo como una sola caja con ese nombre: es lo que se lee primero. No comentes línea por línea.',
    'Si la orden pide algo nuevo que use lo que ya hay («una clase que use esa función»), escribe solo lo nuevo, con lo que ya existe dentro o llamándolo: no vuelvas a escribir el programa ni lo expliques por partes.',
    'Si hay un plan, sigue su orden al pie de la letra: primero TODO lo de la primera parte, luego lo de la segunda… y que cada parte tenga algo de código. Escribe cada función cuando llegue la parte del plan a la que pertenece, no antes. No pongas comentarios con los títulos de las partes: ya están puestos.',
    'No leas ni escribas archivos, no uses la red ni el sistema, ni pidas datos con input(), salvo que la orden lo pida expresamente. Como mucho unas 40 líneas.',
  ].join('\n')
}

export function codePrompt(request: {
  command: string
  where: string
  context: string
  stages: readonly Stage[]
  scope?: readonly string[]
}): string {
  return [
    `Orden: ${request.command}`,
    request.stages.length >= 2
      ? `El plan:\n${request.stages
          .map((stage, i) => `${i + 1}. ${stage.title}${stage.goal ? `: ${stage.goal}` : ''}`)
          .join('\n')}`
      : '',
    `Dónde va: ${request.where}.`,
    request.scope?.length ? `Nombres que ya existen ahí: ${request.scope.join(', ')}.` : '',
    request.context,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

export function tellSystem(teach: boolean): string {
  return [
    teach
      ? 'Estás explicando un tema a alguien mientras construyes, pieza a pieza, un programa que lo modela. De cada pieza, di qué ocurre en la realidad y cómo lo representa; no describas la sintaxis.'
      : 'Estás construyendo un programa pieza a pieza mientras lo explicas a alguien que aprende. De cada pieza, di qué es y por qué se pone ahí, como quien piensa en voz alta.',
    'Te doy las piezas en el orden en que van a aparecer. Di una frase por cada pieza, en español y sin código: una por línea, en el mismo orden, tantas líneas como piezas. Solo las frases: se leerán en voz alta, cada una al aparecer su pieza. De lo que ya está escrito no digas nada: ya se explicó.',
    'Frases MUY cortas: como mucho doce palabras cada una, directas, sin rodeos ni muletillas («en este paso», «aquí»). Una idea por frase.',
  ].join('\n')
}

export function tellPrompt(request: {
  command: string
  pieces: readonly string[]
  stage?: Stage
  written: string
}): string {
  return [
    `Lo que se pidió: ${request.command}`,
    request.stage ? `Parte del plan en la que estamos: ${request.stage.title}` : '',
    request.written ? `Lo que ya está escrito:\n${request.written.slice(-1200)}` : '',
    `Las piezas que van a aparecer ahora (${request.pieces.length}):\n${request.pieces
      .map((piece, index) => `[${index + 1}]\n${piece}`)
      .join('\n')}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

/** El comentario de entrada: qué se va a hacer, antes de enseñar el plan. */
export function introSystem(teach: boolean): string {
  return [
    teach
      ? 'Alguien quiere entender un tema y se lo vas a explicar construyendo, pieza a pieza, un pequeño programa que lo modela.'
      : 'Alguien te ha pedido un programa y lo vas a construir delante de él, pieza a pieza, explicándolo.',
    'Antes de empezar, dile en UNA sola frase corta (menos de dieciocho palabras) qué vais a hacer. Cercano y directo, en español, sin código ni listas. Solo esa frase: se leerá en voz alta, y hasta que acabe no se ve nada.',
  ].join('\n')
}

export function formulaSystem(): string {
  return 'Escribe solo la fórmula matemática que calcula esta función, en términos de x. Puedes usar números, + - * / **, paréntesis y exp, log, sqrt, sin, cos, tan, tanh, abs, max, min. Solo la fórmula, en una línea.'
}
