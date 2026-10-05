import type { BuildStep, Stage } from './build.ts'
import type { Decider, JevQuestion } from './client.ts'

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
  const whole = (): BuildStep[] => [
    {
      level: 0,
      code: lines.map((line) => line.slice(Math.min(base, indentOf(line))).trimEnd()).join('\n'),
      say: '',
      whole: true,
    },
  ]
  // Las líneas lógicas: una sentencia que ocupa varias (un paréntesis abierto) es una sola pieza.
  const logical: string[] = []
  for (const line of lines) {
    const last = logical[logical.length - 1]
    if (last !== undefined && unfinished(last)) logical[logical.length - 1] = `${last}\n${line}`
    else if (line.trim() !== '') logical.push(line)
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

// ───────────────────────── lo que se le pide a la IA: solo contenido ─────────────────────────

const TEACH =
  'El usuario no ha pedido un programa: quiere ENTENDER un tema. El programa es tu pizarra: un modelo pequeño que lo simule con datos de ejemplo, con nombres tomados del tema.'

export function planSystem(teach: boolean): string {
  return [
    teach
      ? `${TEACH} Piensa las partes de la EXPLICACIÓN (qué pasa primero, qué después), no partes de un programa cualquiera.`
      : 'Alguien te pide un programa en Python y tú lo vas a construir explicándolo. Antes de escribir nada, piensa el plan.',
    'Lista las partes por las que pasa, en orden, una por línea: un título de dos a cuatro palabras y, si quieres, detrás de dos puntos, una frase corta que diga qué ocurre en esa parte.',
    'Entre 2 y 7 partes. Solo la lista: sin introducción, sin código y sin despedida.',
  ].join('\n')
}

export function codeSystem(teach: boolean): string {
  return [
    teach
      ? `${TEACH} Sé riguroso con el tema: no inventes datos; si usas valores aproximados, que sean razonables.`
      : 'Escribes un programa en Python que un editor va a dibujar como un diagrama, pieza a pieza.',
    'Escribe el código, y solo el código: Python tal cual iría en el archivo, sin explicaciones alrededor.',
    'Código claro, de principiante: nombres en español, valores de ejemplo concretos, sin trucos. Usa los nombres que ya existen cuando la orden se refiera a ellos, y no repitas lo que ya está en el programa.',
    'Si hay un plan, sigue su orden: primero lo de la primera parte, luego lo de la segunda… No pongas comentarios con los títulos de las partes: ya están puestos.',
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
    'Te doy las piezas en el orden en que van a aparecer. Di una frase corta por cada pieza, en español y sin código: una por línea, en el mismo orden, tantas líneas como piezas. Solo las frases: se leerán en voz alta, cada una al aparecer su pieza.',
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

export function formulaSystem(): string {
  return 'Escribe solo la fórmula matemática que calcula esta función, en términos de x. Puedes usar números, + - * / **, paréntesis y exp, log, sqrt, sin, cos, tan, tanh, abs, max, min. Solo la fórmula, en una línea.'
}
