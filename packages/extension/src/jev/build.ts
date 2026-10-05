import type { Program } from '@prysel/python'
import { addCode, type Change } from '@prysel/python/edits'
import type { Decider, JevQuestion } from './client.ts'
import type { Spot } from './engine.ts'

/**
 * Construir un programa **paso a paso**, mientras se explica.
 *
 * Una orden compleja no se escribe de golpe. La IA generativa va dictando, en streaming, un paso por línea:
 * una sentencia y la frase que la cuenta. Cada paso, en cuanto llega entero, se juzga (el JEV: ¿es seguro?,
 * ¿cómo se enseña?), se escribe en el archivo y aparece en el diagrama con su animación, antes de que
 * el modelo haya terminado de pensar el siguiente. Así se ve —y se oye— cómo se arma el programa, en el
 * orden en que alguien lo explicaría: los datos, lo que se hace con ellos, el resultado.
 *
 * Tres cosas lo hacen posible:
 * - `StepStream`: saca pasos completos de un texto que llega a trozos (un JSON por línea).
 * - `BuildPlan`: sabe dónde va cada paso. Los pasos llegan en el orden del archivo, así que cada uno se
 *   escribe **al final de lo que ya hay**: lo anterior no se mueve, y el Python es válido en todo momento
 *   (una cabecera compuesta nace con un `pass`, que su primer paso de dentro sustituye).
 * - `judgeStep`: lo que el JEV decide de cada paso. Es rápido y determinista: cabe entre paso y paso.
 *
 * Se puede cortar en cualquier momento: lo escrito hasta ahí es un programa que funciona, y se deshace
 * paso a paso desde el lienzo.
 *
 * Todo aquí es puro (no hay red ni VS Code): quien lo orquesta es el anfitrión.
 */

/** Un programa dictado en más pasos que estos ya no es una orden. */
export const MAX_BUILD_STEPS = 30

export interface BuildStep {
  /** Cuántos bloques hay por encima: 0 es el sitio donde se pidió; 1, dentro de la última cabecera de nivel 0… */
  level: number
  /** Una sentencia (de una compuesta, solo su cabecera), quizá con un rótulo de etapa encima. */
  code: string
  /** Lo que se dice al ponerla. */
  say: string
}

// ───────────────────────── del streaming a los pasos ─────────────────────────

/** Lee un paso de una línea de la respuesta. `null` si esa línea no es un paso (una valla, texto suelto). */
export function parseStep(line: string): BuildStep | null {
  const trimmed = line.trim().replace(/,$/, '')
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  const { nivel, level, code, say } = value as Record<string, unknown>
  const depth = typeof nivel === 'number' ? nivel : typeof level === 'number' ? level : 0
  if (typeof code !== 'string' || code.trim() === '') return null
  return {
    level: Number.isInteger(depth) && depth >= 0 ? depth : 0,
    code: code.replace(/\r\n/g, '\n').replace(/\s+$/, ''),
    say: typeof say === 'string' ? say.trim().slice(0, 300) : '',
  }
}

/** Saca pasos enteros de un texto que llega a trozos: un paso por línea, en cuanto la línea se cierra. */
export class StepStream {
  private buffer = ''

  push(delta: string): BuildStep[] {
    this.buffer += delta
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.flatMap((line) => parseStep(line) ?? [])
  }

  /** Lo que quedara sin salto de línea al acabar. */
  end(): BuildStep[] {
    const rest = this.buffer
    this.buffer = ''
    return rest.split('\n').flatMap((line) => parseStep(line) ?? [])
  }
}

// ───────────────────────── dónde va cada paso ─────────────────────────

interface Level {
  /** La línea de la cabecera que abre este bloque (`null`: el sitio donde se pidió). */
  owner: number | null
  /** El bloque es el «no» (`else`) de esa decisión. */
  branch?: 'no'
  /** La línea de la última sentencia escrita en este bloque. */
  last: number | null
}

export type Placed =
  | { ok: true; change: Change; line: number; opens: boolean }
  /** Un `else:` no escribe nada: abre el camino del «no» para los pasos que siguen. */
  | { ok: true; change: null; line: number; opens: true }
  | { ok: false; error: string }

/** El texto de la sentencia de un paso, sin los comentarios que lleve encima. */
const statementOf = (code: string) =>
  code
    .split('\n')
    .filter((row) => row.trim() !== '' && !row.trimStart().startsWith('#'))
    .join('\n')

/** Una cabecera compuesta sola (`for x in y:`): su cuerpo llega en los pasos siguientes. */
const isHeader = (statement: string) => !statement.includes('\n') && /:\s*$/.test(statement)

const UNSUPPORTED = /^(elif|try|except|finally|match|case|class)\b/

/**
 * Dónde va cada paso, y lo que cada uno deja abierto. Se le pregunta (`place`) con el programa de ahora, y
 * se le confirma (`commit`) cuando el paso ya está escrito.
 */
export class BuildPlan {
  private levels: Level[]

  constructor(private readonly spot: Spot) {
    this.levels = [{ owner: null, last: null }]
  }

  /** Cuántos bloques hay abiertos ahora (0: solo el sitio de partida). */
  get depth(): number {
    return this.levels.length - 1
  }

  place(program: Program, step: BuildStep): Placed {
    const statement = statementOf(step.code)
    if (statement === '') return { ok: false, error: 'El paso no trae ninguna sentencia.' }
    if (UNSUPPORTED.test(statement)) {
      return { ok: false, error: `Esa construcción no se arma paso a paso: «${statement}».` }
    }
    // Un paso más hondo de lo que hay abierto va en lo más hondo que haya; uno menos hondo cierra bloques.
    const level = Math.min(step.level, this.depth)
    const here = this.levels[level]
    if (!here) return { ok: false, error: 'El paso no tiene dónde ir.' }
    const at = (line: number | null) =>
      line === null ? undefined : program.nodes.find((n) => n.range && n.line === line)

    if (/^else\s*:\s*$/.test(statement)) {
      const decision = at(here.last)
      if (decision?.kind !== 'control.condition') {
        return { ok: false, error: 'Hay un «else» sin una decisión justo antes.' }
      }
      return { ok: true, change: null, line: decision.line, opens: true }
    }

    const opens = isHeader(statement)
    const code = opens ? `${step.code}\n    pass` : step.code
    const previous = at(here.last)
    const owner = at(here.owner)
    if (here.last !== null && !previous) return { ok: false, error: 'El paso anterior ya no está.' }
    if (here.owner !== null && !owner) return { ok: false, error: 'El bloque del paso ya no está.' }
    const where: Spot = previous
      ? { after: previous.id }
      : owner
        ? here.branch
          ? { into: owner.id, branch: 'no' }
          : { into: owner.id }
        : this.spot
    const change = addCode(program, where, code)
    if (change.edits.length === 0 || !change.select) {
      return { ok: false, error: 'El paso no cabe en ese sitio.' }
    }
    // Lo primero que entra en un «no» crea su `else:`: la sentencia queda una línea más abajo.
    const createsElse =
      !previous && here.branch === 'no' && owner !== undefined && owner.range?.elseAt === undefined
    return { ok: true, change, line: change.select.line + (createsElse ? 1 : 0), opens }
  }

  /** El paso ya está escrito, en esa línea. */
  commit(step: BuildStep, placed: Extract<Placed, { ok: true }>): void {
    const level = Math.min(step.level, this.depth)
    this.levels = this.levels.slice(0, level + 1)
    const here = this.levels[level]
    if (!here) return
    if (placed.change === null) {
      this.levels.push({ owner: placed.line, branch: 'no', last: null })
      return
    }
    here.last = placed.line
    if (placed.opens) this.levels.push({ owner: placed.line, last: null })
  }
}

// ───────────────────────── lo que se le pide a la IA generativa ─────────────────────────

export function buildStepsSystem(): string {
  return [
    'Construyes un programa en Python paso a paso mientras lo explicas en voz alta a alguien que está aprendiendo. Un editor dibuja cada paso como un nodo de un diagrama en cuanto lo dices.',
    'Tu respuesta son líneas JSON (JSON Lines), una por paso, sin nada más (ni vallas de código, ni texto):',
    '{"nivel": 0, "code": "…", "say": "…"}',
    '«code»: UNA sentencia de Python. Los pasos van en el orden en que quedan en el archivo, de arriba abajo: cada paso se escribe detrás del anterior.',
    'De una sentencia compuesta (def, for, while, if, with) escribe solo su cabecera, acabada en dos puntos; lo de dentro va en los pasos siguientes, con «nivel» una unidad mayor. Para volver a salir, usa un «nivel» menor.',
    'Un «else» es un paso con code "else:" al mismo nivel que su if; lo que va dentro, en los pasos siguientes con un nivel más. No uses elif, try, match ni class.',
    '«nivel» 0 es el sitio donde se pidió el código.',
    '«say»: una frase corta, en español y sin código, que diga qué es esa pieza y por qué se pone ahí, como quien piensa en voz alta mientras explica. Se leerá en voz alta al aparecer el nodo.',
    'Ordena los pasos para que se entienda: primero los datos, luego lo que se hace con ellos, luego el resultado, siempre que el orden del archivo lo permita (una función se define antes de usarla).',
    'Si el programa tiene varias fases, puedes empezar una etapa poniendo una línea de comentario («# Preparar los datos») encima de la sentencia, dentro del mismo «code»: al menos dos etapas por bloque, o ninguna.',
    'Código claro, de principiante: nombres en español, valores de ejemplo concretos, sin trucos. Usa los nombres que ya existen cuando la orden se refiera a ellos, y no repitas lo que ya está en el programa.',
    'No leas ni escribas archivos, no uses la red ni el sistema, ni pidas datos con input(), salvo que la orden lo pida expresamente.',
    `Como mucho ${MAX_BUILD_STEPS} pasos.`,
  ].join('\n')
}

const MAX_CONTEXT = 12_000

export function buildStepsPrompt(request: {
  command: string
  program: Program
  where: string
  scope?: readonly string[]
}): string {
  const source = request.program.source
  return [
    `Orden: ${request.command}`,
    `Dónde va: ${request.where}.`,
    request.scope?.length ? `Nombres que ya existen ahí: ${request.scope.join(', ')}.` : '',
    source.trim() === ''
      ? 'El programa está vacío: constrúyelo desde cero.'
      : `El programa ahora:\n${source.length > MAX_CONTEXT ? source.slice(-MAX_CONTEXT) : source}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

// ───────────────────────── lo que el JEV decide de cada paso ─────────────────────────

export const STEP_THRESHOLDS = {
  /** Por debajo, el paso no se escribe y la construcción se detiene. */
  safe: 0.7,
  /** Por debajo, la cámara y el ritmo son los de siempre. */
  staging: 0.5,
} as const

export interface StepVerdict {
  safe: number
  /** La cámara enseña el conjunto (lo nuevo dentro de lo que ya hay) en vez de acercarse a la pieza. */
  wide: boolean
  /** Es un paso clave: se le deja más tiempo antes del siguiente. */
  pause: boolean
  ms: number
}

export function stepQuestions(): Record<string, JevQuestion> {
  return {
    seguro: {
      type: 'noul',
      instructions:
        'El campo `codigo` es una sentencia de Python que se va a añadir a un programa para cumplir la `orden`. ¿Se puede escribir y ejecutar sin riesgo para el equipo de quien lo pidió?',
      criteria: {
        true: 'Solo calcula, guarda valores, define funciones o imprime; o toca archivos, la red o el sistema porque la orden lo pide expresamente.',
        false:
          'Borra o sobrescribe archivos, usa la red, lanza otros programas o ejecuta código dinámico sin que la orden lo pida.',
      },
    },
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
  }
}

export async function judgeStep(
  decider: Decider,
  command: string,
  step: BuildStep,
): Promise<StepVerdict> {
  const { answers, ms } = await decider.decide({
    state: { orden: command, codigo: step.code, explicacion: step.say },
    questions: stepQuestions(),
  })
  const safe = answers.seguro?.type === 'noul' ? answers.seguro.noul : 0
  const sure = (id: string, option: string) => {
    const answer = answers[id]
    return (
      answer?.type === 'choice' &&
      answer.choice === option &&
      answer.confidence >= STEP_THRESHOLDS.staging
    )
  }
  return { safe, wide: sure('camara', 'conjunto'), pause: sure('ritmo', 'pausa'), ms }
}

/** Cuánto se espera tras un paso antes del siguiente: lo que se tarda en decir su frase, y algo más si es clave. */
export function paceOf(step: BuildStep, pause: boolean): number {
  const spoken = Math.min(5000, 600 + step.say.length * 55)
  return Math.round(pause ? spoken * 1.35 : spoken)
}
