import type { Program } from '@prysel/python'
import { addCode, fillGenerated, type Change } from '@prysel/python/edits'
import type { Decider, JevQuestion } from './client.ts'
import type { Spot } from './engine.ts'
import { visualOf, withVisual, type Visual } from './visual.ts'

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
  /** Una ayuda visual que la acompaña (la curva de la función que usa, una tabla de valores). */
  visual?: Visual
  /**
   * Es una sentencia entera, con su cuerpo (un `try`, un `if` con sus `elif`): se escribe de una vez, tal
   * cual, en vez de armarse línea a línea.
   */
  whole?: boolean
}

// ───────────────────────── del streaming a los pasos ─────────────────────────

/**
 * Saca objetos JSON enteros de un texto que llega a trozos, en cuanto cada uno se cierra, vengan como
 * vengan: uno por línea, dentro de una lista, con sangría, entre vallas de código o envueltos en otro objeto
 * (`{"pasos": [{…}, {…}]}`). Un modelo no siempre respeta el formato que se le pide: lo que importa es que
 * cada paso se vea en cuanto está completo. `accept` dice si un objeto es de los que se buscan.
 */
export class ObjectStream<T> {
  private text = ''
  /** Dónde empieza cada llave aún abierta. */
  private open: number[] = []
  private at = 0
  private inString = false
  private escaped = false

  constructor(private readonly accept: (value: unknown) => T | null) {}

  push(delta: string): T[] {
    this.text += delta
    const found: T[] = []
    for (; this.at < this.text.length; this.at++) {
      const char = this.text[this.at]
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (char === '\\') this.escaped = true
        else if (char === '"') this.inString = false
        continue
      }
      // Fuera de un objeto, unas comillas son texto suelto (una valla, una frase): no abren nada.
      if (char === '"' && this.open.length > 0) this.inString = true
      else if (char === '{') this.open.push(this.at)
      else if (char === '}') {
        const start = this.open.pop()
        if (start === undefined) continue
        try {
          const value = this.accept(JSON.parse(this.text.slice(start, this.at + 1)))
          if (value !== null) found.push(value)
        } catch {
          // No era JSON (texto con llaves): se sigue buscando.
        }
      }
    }
    // Lo ya leído que no pertenece a ningún objeto abierto no hace falta guardarlo.
    if (this.open.length === 0) {
      this.text = this.text.slice(this.at)
      this.at = 0
    }
    return found
  }

  /** Lo que llevaba sin cerrar al acabar (para decir qué contestó el modelo, si no sirvió). */
  get rest(): string {
    return this.text
  }
}

/** Lee un paso de un objeto de la respuesta. `null` si no lo es. */
export function stepOf(value: unknown): BuildStep | null {
  if (typeof value !== 'object' || value === null) return null
  const { nivel, level, code, say, ver } = value as Record<string, unknown>
  const depth = typeof nivel === 'number' ? nivel : typeof level === 'number' ? level : 0
  if (typeof code !== 'string' || code.trim() === '') return null
  const visual = visualOf(ver)
  return {
    level: Number.isInteger(depth) && depth >= 0 ? depth : 0,
    code: code.replace(/\r\n/g, '\n').replace(/\s+$/, ''),
    say: typeof say === 'string' ? say.trim().slice(0, 300) : '',
    ...(visual ? { visual } : {}),
  }
}

/** Lee un paso de una línea de la respuesta. `null` si esa línea no es un paso (una valla, texto suelto). */
export function parseStep(line: string): BuildStep | null {
  const trimmed = line.trim().replace(/,$/, '')
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    return stepOf(JSON.parse(trimmed))
  } catch {
    return null
  }
}

/** Saca pasos enteros de un texto que llega a trozos, en cuanto cada uno se cierra. */
export class StepStream {
  private readonly objects = new ObjectStream(stepOf)

  push(delta: string): BuildStep[] {
    return this.objects.push(delta)
  }

  /** Al acabar no queda nada a medias que valga: un objeto sin cerrar no es un paso. */
  end(): BuildStep[] {
    return []
  }
}

/** Quien lee una respuesta que llega a trozos y va entregando lo que encuentra. */
export interface Reader<T> {
  push(delta: string): T[]
  /** Al acabar la respuesta: lo que quedara a medias y aún se pueda aprovechar. */
  end(): T[]
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

/**
 * Un paso que es solo un comentario (un rótulo, una aclaración): no es una sentencia, así que no se puede
 * escribir suelto, pero tampoco es un error. Va encima de la sentencia del paso siguiente.
 */
export const isCommentOnly = (code: string) => code.trim() !== '' && statementOf(code) === ''

/** Una cabecera compuesta sola (`for x in y:`): su cuerpo llega en los pasos siguientes. */
const isHeader = (statement: string) => !statement.includes('\n') && /:\s*$/.test(statement)

const UNSUPPORTED = /^(elif|try|except|finally|match|case|class)\b/

/**
 * Dónde va cada paso, y lo que cada uno deja abierto. Se le pregunta (`place`) con el programa de ahora, y
 * se le confirma (`commit`) cuando el paso ya está escrito.
 */
export class BuildPlan {
  private levels: Level[]

  /**
   * `replaces`: lo primero que se escriba no se añade, sino que ocupa el sitio de una pieza marcada como
   * «generándose» (por su id): el hueco que el esquema dejó para esta etapa.
   */
  constructor(
    private readonly spot: Spot,
    private readonly replaces?: string,
  ) {
    this.levels = [{ owner: null, last: null }]
  }

  /** Cuántos bloques hay abiertos ahora (0: solo el sitio de partida). */
  get depth(): number {
    return this.levels.length - 1
  }

  place(program: Program, step: BuildStep): Placed {
    const statement = statementOf(step.code)
    if (statement === '') return { ok: false, error: 'El paso no trae ninguna sentencia.' }
    if (!step.whole && UNSUPPORTED.test(statement)) {
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

    const opens = !step.whole && isHeader(statement)
    const body = opens ? `${step.code}\n    pass` : step.code
    // La ayuda visual del paso va con él, como una marca al final de la línea de su sentencia.
    const code = step.visual ? withVisual(body, step.visual) : body
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
    const fills = level === 0 && !previous && this.replaces !== undefined
    const change = fills
      ? fillGenerated(program, this.replaces, code)
      : addCode(program, where, code)
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
    'No escribas JSON ni vallas de código ni texto de más. Cada paso son estos campos, cada uno en su línea y con su etiqueta en mayúsculas, en este orden:',
    'NIVEL: 0',
    'CODIGO: numero_1 = 3',
    'DICE: Guardamos el primer número.',
    '(una línea en blanco entre paso y paso)',
    'CODIGO: UNA sentencia de Python, tal cual se escribe (sin comillas alrededor ni escapes). Los pasos van en el orden en que quedan en el archivo, de arriba abajo: cada paso se escribe detrás del anterior.',
    'De una sentencia compuesta (def, for, while, if, with) escribe solo su cabecera, acabada en dos puntos; lo de dentro va en los pasos siguientes, con NIVEL una unidad mayor. Para volver a salir, usa un NIVEL menor.',
    'Un «else» es un paso con CODIGO: else: al mismo nivel que su if; lo que va dentro, en los pasos siguientes con un nivel más. No uses elif, try, match ni class.',
    'NIVEL 0 es el sitio donde se pidió el código.',
    'DICE: una sola frase corta (menos de 25 palabras), en español y sin código, que diga qué es esa pieza y por qué se pone ahí, como quien piensa en voz alta mientras explica. Se leerá en voz alta al aparecer el nodo. Va siempre al final del paso.',
    'Ordena los pasos para que se entienda: primero los datos, luego lo que se hace con ellos, luego el resultado, siempre que el orden del archivo lo permita (una función se define antes de usarla).',
    'Si el programa tiene varias fases, puedes empezar una etapa poniendo una línea de comentario («# Preparar los datos») encima de la sentencia, dentro del mismo CODIGO (en la línea anterior): al menos dos etapas por bloque, o ninguna. Un comentario nunca va solo en un paso.',
    'Código claro, de principiante: nombres en español, valores de ejemplo concretos, sin trucos. Usa los nombres que ya existen cuando la orden se refiera a ellos, y no repitas lo que ya está en el programa.',
    'No leas ni escribas archivos, no uses la red ni el sistema, ni pidas datos con input(), salvo que la orden lo pida expresamente.',
    'Sé proactivo ayudando a entender. Cuando un paso use una función matemática o una fórmula que se entiende mejor viéndola (una sigmoide, una ReLU, un error cuadrático, un crecimiento, una probabilidad), añade al paso una ayuda visual con una línea VER (entre NIVEL y CODIGO): el editor dibuja al lado un nodo auxiliar que no forma parte del programa.',
    '  Una curva (tipo | título | fórmula de x | desde | hasta):   VER: curva | Sigmoide | 1/(1+exp(-x)) | -6 | 6',
    '  Una tabla de valores (tipo | título | fórmula de x | valores de x):   VER: tabla | Elevar al cuadrado | x**2 | -2 -1 0 1 2',
    '  En la fórmula solo caben x, números, + - * / ** y paréntesis, y las funciones exp, log, sqrt, sin, cos, tan, tanh, abs, max, min. Pon una ayuda donde de verdad aclare (una o dos por programa), no en cada paso.',
    `Como mucho ${MAX_BUILD_STEPS} pasos.`,
  ].join('\n')
}

export function buildStepsPrompt(request: {
  command: string
  where: string
  context: string
  scope?: readonly string[]
}): string {
  return [
    `Orden: ${request.command}`,
    `Dónde va: ${request.where}.`,
    request.scope?.length ? `Nombres que ya existen ahí: ${request.scope.join(', ')}.` : '',
    request.context,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

// ───────────────────────── primero el esquema, luego cada etapa ─────────────────────────

/** Una etapa del esquema: su rótulo y, en una frase, qué hace. */
export interface Stage {
  title: string
  goal: string
}

export const MAX_STAGES = 7

export function stageOf(value: unknown): Stage | null {
  if (typeof value !== 'object' || value === null) return null
  const { titulo, title, que, goal } = value as Record<string, unknown>
  const name = typeof titulo === 'string' ? titulo : typeof title === 'string' ? title : ''
  const what = typeof que === 'string' ? que : typeof goal === 'string' ? goal : ''
  // Los dos puntos separan el título de su subtítulo en el rótulo: dentro del título estorban.
  const clean = name
    .replace(/[:\s]+/g, ' ')
    .replace(/^#+\s*/, '')
    .trim()
  if (clean === '' || clean.length > 60) return null
  return { title: clean, goal: what.replace(/\s+/g, ' ').trim().slice(0, 300) }
}

/**
 * Cuando no se pidió un programa sino **entender un tema**: el programa es el medio. Se añade a lo que se le
 * pide a la IA en el plan y en cada etapa.
 */
export function teachingNote(): string {
  return [
    'IMPORTANTE: el usuario no ha pedido un programa: quiere ENTENDER un tema. El programa es tu pizarra.',
    'Diseña un programa pequeño de Python que modele o simule ese tema con datos de ejemplo concretos (cantidades, etapas, probabilidades, una evolución en el tiempo…), de modo que al construirlo pieza a pieza se vaya explicando. Sirve para cualquier tema, aunque no sea de informática: biología, historia, economía, física.',
    'Las etapas son las partes de la EXPLICACIÓN (qué pasa primero, qué después, por qué), no partes de un programa cualquiera. Sus títulos nombran el tema, no el código.',
    'Cada «say» enseña el tema: di qué ocurre en la realidad y cómo lo representa esa pieza. No describas la sintaxis.',
    'Usa nombres de variables y funciones tomados del tema. Si algo se entiende mejor con una curva o una tabla, añade su ayuda visual. Sé riguroso: no inventes datos; si usas valores aproximados, que sean razonables.',
  ].join('\n')
}

export function outlineSystem(teach = false): string {
  return [
    ...(teach ? [teachingNote()] : []),
    'Alguien te pide un programa en Python y tú lo vas a construir explicándolo. Antes de escribir nada, piensa el plan: las etapas por las que pasa, a grandes rasgos, como el índice de una explicación.',
    'No escribas JSON ni texto de más. Cada etapa son dos líneas, con su etiqueta en mayúsculas, y una línea en blanco entre etapa y etapa:',
    'ETAPA: Calcular la media',
    'QUE: Suma las notas y divide entre cuántas son.',
    'ETAPA: dos a cuatro palabras, con un verbo («Pedir los datos», «Calcular la media»). QUE: UNA sola frase, de menos de 20 palabras, que diga qué hace esa etapa y con qué. Sé breve: es el índice, no la explicación.',
    `Entre 2 y ${MAX_STAGES} etapas, en el orden en que se ejecutan. Cada etapa es una fase con sentido propio, no una línea de código. No escribas código todavía.`,
  ].join('\n')
}

export function outlinePrompt(request: {
  command: string
  where: string
  context: string
}): string {
  return [`Orden: ${request.command}`, `Dónde va: ${request.where}.`, request.context]
    .filter((part) => part !== '')
    .join('\n\n')
}

/** El hueco que el esquema deja para una etapa: su rótulo y una pieza marcada, que su detalle sustituye. */
export function stageSkeleton(stages: readonly Stage[], gen: string): string {
  return stages
    .map((stage, index) => `${stageHeading(stage)}\n...  # prysel:gen:${stageGen(gen, index)}`)
    .join('\n\n')
}

/**
 * El rótulo de una etapa del plan, como va en el código: `# Título: qué hace`. El lienzo enseña el título
 * en la tarjeta y lo demás debajo, así que el plan se lee en el diagrama antes de que haya código.
 */
export function stageHeading(stage: Stage): string {
  const goal = stage.goal.replace(/[.\s]+$/, '')
  const about = goal.length > 90 ? `${goal.slice(0, 89)}…` : goal
  return about === '' ? `# ${stage.title}` : `# ${stage.title}: ${about}`
}

/** El id de la marca de la etapa `index` de una construcción. */
export const stageGen = (gen: string, index: number) => `${gen}s${index}`

export function stageSystem(teach = false): string {
  return [
    buildStepsSystem(),
    ...(teach ? [teachingNote()] : []),
    'Ahora detallas UNA etapa de un plan que ya está decidido. Escribe solo los pasos de esa etapa: no repitas lo de las anteriores (ya está escrito) ni te adelantes a las siguientes.',
    'No pongas comentarios de etapa: su rótulo ya está en el programa. «nivel» 0 es el sitio de esa etapa.',
  ].join('\n')
}

export function stagePrompt(request: {
  command: string
  stages: readonly Stage[]
  index: number
  context: string
}): string {
  const plan = request.stages
    .map(
      (stage, i) =>
        `${i + 1}. ${stage.title}${stage.goal ? `: ${stage.goal}` : ''}${i === request.index ? '   ◀ ESTA' : i < request.index ? '   (ya escrita)' : ''}`,
    )
    .join('\n')
  return [
    `Orden: ${request.command}`,
    `El plan:\n${plan}`,
    `Detalla la etapa ${request.index + 1}: «${request.stages[request.index]?.title ?? ''}».`,
    request.context,
  ].join('\n\n')
}

// ───────────────────────── lo que el JEV decide de cada paso ─────────────────────────

export const STEP_THRESHOLDS = {
  /** Por debajo, el paso no se escribe y la construcción se detiene. */
  safe: 0.7,
  /** Por debajo, la cámara y el ritmo son los de siempre. */
  staging: 0.5,
  /** Por debajo, el paso no encaja con lo que dice o con lo que se pidió: se manda rehacer (una vez). */
  fits: 0.4,
  /** Por debajo, una etapa del plan no pinta nada en lo que se pidió: se deja fuera. */
  stage: 0.3,
} as const

export interface StepVerdict {
  safe: number
  /** Si el código hace lo que dice su frase y sirve a lo que se pidió (0 a 1). */
  fits: number
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
    encaja: {
      type: 'noul',
      instructions:
        '¿El `codigo` hace lo que dice su `explicacion`, y es un paso que sirve para cumplir la `orden`?',
      criteria: {
        true: 'El código y su explicación dicen lo mismo, y el paso tiene que ver con lo que se pidió.',
        false:
          'El código hace otra cosa que lo que se explica, está a medias (un nombre sin definir, puntos suspensivos), o no tiene que ver con la orden.',
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
  // Si el JEV no contesta a esto, no es motivo para rehacer nada.
  const fits = answers.encaja?.type === 'noul' ? answers.encaja.noul : 1
  return { safe, fits, wide: sure('camara', 'conjunto'), pause: sure('ritmo', 'pausa'), ms }
}

/** ¿Pinta algo esta etapa en lo que se pidió? Lo que el JEV dice de cada etapa del plan, según llega. */
export async function judgeStage(
  decider: Decider,
  command: string,
  stage: Stage,
): Promise<{ fits: number; ms: number }> {
  const { answers, ms } = await decider.decide({
    state: { orden: command, etapa: stage.title, que: stage.goal },
    questions: {
      pertinente: {
        type: 'noul',
        instructions:
          'La `etapa` es una parte del plan para cumplir la `orden`. ¿Tiene que ver con lo que se pidió?',
        criteria: {
          true: 'Es una parte razonable de lo que se pidió, o de su explicación.',
          false:
            'No tiene que ver, se repite, o es relleno (una introducción vacía, una despedida).',
        },
      },
    },
  })
  return { fits: answers.pertinente?.type === 'noul' ? answers.pertinente.noul : 1, ms }
}

/** Lo que se le pide a la IA para rehacer un paso que el JEV no dio por bueno. */
export function reworkPrompt(command: string, step: BuildStep, context: string): string {
  return [
    `Orden: ${command}`,
    'Este paso no ha pasado la revisión: su código no hace lo que dice su frase, está a medias, o no sirve a la orden.',
    `NIVEL: ${step.level}\nCODIGO: ${step.code}\nDICE: ${step.say}`,
    'Rehaz SOLO este paso (uno, con el mismo NIVEL), de modo que el código y la frase digan lo mismo y encaje con lo que ya hay.',
    context,
  ].join('\n\n')
}

/** Cuánto se espera tras un paso antes del siguiente: lo que se tarda en decir su frase, y algo más si es clave. */
export function paceOf(step: BuildStep, pause: boolean): number {
  const spoken = Math.min(5000, 600 + step.say.length * 55)
  return Math.round(pause ? spoken * 1.35 : spoken)
}
