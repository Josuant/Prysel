import type { Program } from '@prysel/python'
import { extractJson } from '../ai/json.ts'
import type { AiProvider } from '../ai/provider.ts'
import type { Decider, JevQuestion } from './client.ts'
import type { Evidence } from './engine.ts'
import type { FillRuntime } from './fill.ts'

/**
 * Las órdenes complejas: lo que no cabe en una plantilla («escribe una función que calcule la media y
 * avise si pasa del límite») o lo que son varias órdenes en una.
 *
 * Aquí es donde las dos herramientas se complementan, cada una en lo que sabe hacer:
 *
 * - **La IA generativa redacta**: parte una orden larga en órdenes sencillas, o escribe el código de un
 *   algoritmo entero, ya partido en etapas (comentarios de sección) para que el diagrama lo cuente.
 * - **El JEV decide y juzga**: antes, qué clase de orden es y dónde va lo que se escriba; después, si lo
 *   escrito **cumple la orden** y si **es seguro** escribirlo. Sus respuestas son deterministas y llevan
 *   una probabilidad: con ellas, y con umbrales fijos, se acepta, se manda corregir o se rechaza.
 *
 * La IA generativa nunca escribe en el archivo por su cuenta: todo pasa por el analizador (tiene que ser
 * Python válido) y por el juicio del JEV. Y cada trozo de una orden partida vuelve a pasar por el motor,
 * como si se hubiera dicho suelto.
 *
 * Puro salvo por las dos llamadas (`provider.generate`, `decider.decide`): se prueba con dos de mentira.
 */

export const COMPOSE_THRESHOLDS = {
  /** Por debajo, lo escrito no hace lo que se pidió: se manda corregir (una vez) y, si sigue igual, no se escribe. */
  fulfils: 0.6,
  /** Por debajo, lo escrito toca archivos, la red o el sistema sin que se pidiera: no se escribe. */
  safe: 0.7,
} as const

/** Un intento y una corrección, como el contenido de una pieza. */
export const COMPOSE_ATTEMPTS = 2

const MAX_CONTEXT = 12_000
const MAX_LINES = 80
const MAX_SAY = 500
/** Una orden partida en más trozos que estos no es una orden: es un programa dictado de corrido. */
export const MAX_STEPS = 6

// ───────────────────────── partir una orden ─────────────────────────

/**
 * Parte una orden que son varias en órdenes sencillas, en el orden en que se dijeron. `null` si la
 * respuesta no vale (no es una lista de 2 a 6 frases): entonces la orden se trata como una sola.
 */
export async function splitOrder(provider: AiProvider, text: string): Promise<string[] | null> {
  let raw: string
  try {
    raw = await provider.generate({
      system: [
        'Alguien ha dictado a un editor de diagramas de programas en Python una frase con varias instrucciones.',
        'Pártela en instrucciones sencillas, una por cosa que hay que hacer, en el orden en que se dijeron.',
        'Cada una debe entenderse sola: si dice «renómbrala», escribe qué se renombra.',
        'No añadas instrucciones que no se pidieron ni cambies lo que piden.',
        `Devuelve SOLO un objeto JSON: {"steps": ["…", "…"]}, con entre 2 y ${MAX_STEPS} textos.`,
      ].join('\n'),
      prompt: `Frase: ${text}`,
      maxTokens: 400,
    })
  } catch {
    return null
  }
  const extracted = extractJson(raw)
  if (!extracted.ok) return null
  const steps = (extracted.value as { steps?: unknown }).steps
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > MAX_STEPS) return null
  const clean = steps.map((step) => (typeof step === 'string' ? step.trim() : ''))
  return clean.every((step) => step !== '' && step.length <= 300) ? clean : null
}

// ───────────────────────── escribir el código de una orden ─────────────────────────

export interface ComposeRequest {
  /** La orden, tal como se dijo. */
  command: string
  program: Program
  /** Dónde va a ir lo escrito, dicho con palabras («dentro de función entrenar»). */
  where: string
  /** Los nombres que ya existen ahí. */
  scope?: readonly string[]
  /** La línea junto a la que se escribe, para mandar su contexto si el archivo es largo. */
  line?: number
}

export type ComposeResult =
  | {
      ok: true
      code: string
      /** Lo que se dice de ello en voz alta. */
      say: string
      attempts: number
      /** El juicio del JEV sobre lo escrito. */
      evidence: Evidence[]
      jevMs: number
    }
  | { ok: false; error: string; attempts: number; evidence: Evidence[]; jevMs: number }

export function buildComposeSystem(): string {
  return [
    'Escribes código Python que alguien está dictando a un editor que lo dibuja como un diagrama de flujo.',
    'Devuelve SOLO un objeto JSON, sin texto alrededor: {"code": "…", "say": "…"}.',
    '«code»: el Python que cumple la orden, listo para pegar en el sitio indicado, sin sangría inicial y con 4 espacios por nivel. Solo lo nuevo: no repitas código que ya está en el programa.',
    'Usa los nombres que ya existen cuando la orden se refiera a ellos. Código claro, de principiante: nombres en español, sin trucos.',
    'Si tiene más de tres sentencias seguidas en un mismo bloque, pártelo en etapas: un comentario corto de una línea (por ejemplo «# Preparar los datos») antes de cada fase, precedido de una línea en blanco. Al menos dos etapas por bloque, o ninguna. El diagrama enseña cada etapa como una tarjeta con ese título.',
    'No leas ni escribas archivos, no uses la red ni el sistema, ni pidas datos con input(), salvo que la orden lo pida expresamente.',
    `No pases de ${MAX_LINES} líneas.`,
    '«say»: una o dos frases cortas, en español y sin código, que cuenten qué hace lo escrito. Se leerán en voz alta.',
  ].join('\n')
}

function contextOf(program: Program, line: number | undefined): string {
  if (program.source.length <= MAX_CONTEXT) return program.source
  const lines = program.source.split(/\r?\n/)
  const at = line ?? lines.length
  return lines.slice(Math.max(0, at - 80), at + 40).join('\n')
}

export function buildComposePrompt(request: ComposeRequest): string {
  return [
    `Orden: ${request.command}`,
    `Dónde va: ${request.where}.`,
    request.scope?.length ? `Nombres que ya existen ahí: ${request.scope.join(', ')}.` : '',
    request.program.source.trim() === ''
      ? 'El programa está vacío: escribe lo que haga falta desde cero.'
      : `El programa ahora:\n${contextOf(request.program, request.line)}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

/** ¿Se puede escribir lo generado? Devuelve por qué no, o `null` si vale. */
export function checkCode(runtime: FillRuntime, code: string): string | null {
  if (code.trim() === '') return 'El código está vacío.'
  if (code.split(/\r?\n/).length > MAX_LINES) return `El código pasa de ${MAX_LINES} líneas.`
  if (/^[ \t]/.test(code)) return 'El código no debe empezar con sangría.'
  if (/prysel:gen:/.test(code)) return 'El código no debe llevar la marca «prysel:gen».'
  const parsed = runtime.parse(code)
  if (parsed.hasError) return 'El código no es Python válido.'
  if (!parsed.program.nodes.some((node) => node.range !== undefined)) {
    return 'El código no tiene ninguna sentencia.'
  }
  return null
}

/** Lo que se le pregunta al JEV sobre un código ya escrito: ¿cumple la orden?, ¿es seguro escribirlo? */
export function judgeQuestions(): Record<string, JevQuestion> {
  return {
    cumple: {
      type: 'noul',
      instructions:
        'El campo `codigo` es Python que se ha escrito para cumplir la `orden`. ¿Hace lo que la orden pide?',
      criteria: {
        true: 'Hace lo que se pidió, entero, sin dejar fuera partes de la orden.',
        false:
          'Hace otra cosa, se deja una parte de lo pedido, o está a medias (pass, puntos suspensivos, «por hacer»).',
      },
    },
    seguro: {
      type: 'noul',
      instructions:
        '¿Se puede escribir y ejecutar el `codigo` sin riesgo para el equipo de quien lo pidió?',
      criteria: {
        true: 'Solo calcula, guarda valores e imprime; o toca archivos, la red o el sistema porque la orden lo pide expresamente.',
        false:
          'Borra o sobrescribe archivos, usa la red, lanza otros programas o ejecuta código dinámico sin que la orden lo pida.',
      },
    },
  }
}

interface Judgement {
  fulfils: number
  safe: number
  evidence: Evidence[]
  ms: number
}

export async function judgeCode(
  decider: Decider,
  command: string,
  code: string,
): Promise<Judgement> {
  const { answers, ms } = await decider.decide({
    state: { orden: command, codigo: code },
    questions: judgeQuestions(),
  })
  const value = (id: string) => {
    const answer = answers[id]
    return answer?.type === 'noul' ? answer.noul : 0
  }
  const fulfils = value('cumple')
  const safe = value('seguro')
  return {
    fulfils,
    safe,
    ms,
    evidence: [
      {
        question: 'cumple',
        answer: fulfils >= COMPOSE_THRESHOLDS.fulfils ? 'sí' : 'no',
        confidence: fulfils,
      },
      {
        question: 'seguro',
        answer: safe >= COMPOSE_THRESHOLDS.safe ? 'sí' : 'no',
        confidence: safe,
      },
    ],
  }
}

/**
 * Escribe el código de una orden compleja: la IA generativa lo redacta, el analizador comprueba que es
 * Python y el JEV juzga si cumple y si es seguro. Lo que no cumple se manda corregir una vez, diciendo por
 * qué; lo que no es seguro no se corrige ni se escribe.
 */
export async function composeCode(
  provider: AiProvider,
  decider: Decider,
  runtime: FillRuntime,
  request: ComposeRequest,
): Promise<ComposeResult> {
  const system = buildComposeSystem()
  const base = buildComposePrompt(request)
  let prompt = base
  let error = 'El modelo no respondió.'
  let evidence: Evidence[] = []
  let jevMs = 0
  for (let attempt = 1; attempt <= COMPOSE_ATTEMPTS; attempt++) {
    let raw: string
    try {
      raw = await provider.generate({ system, prompt, maxTokens: 2500 })
    } catch (failure) {
      return {
        ok: false,
        error: `El modelo no respondió: ${failure instanceof Error ? failure.message : String(failure)}`,
        attempts: attempt,
        evidence,
        jevMs,
      }
    }
    const extracted = extractJson(raw)
    const value = extracted.ok ? (extracted.value as { code?: unknown; say?: unknown }) : null
    if (!extracted.ok) error = extracted.error
    else if (typeof value?.code !== 'string' || typeof value.say !== 'string') {
      error = 'Faltan «code» o «say» (dos textos).'
    } else {
      const code = value.code.replace(/\r\n/g, '\n').replace(/\s+$/, '')
      const problem = checkCode(runtime, code)
      if (problem !== null) error = problem
      else {
        const verdict = await judgeCode(decider, request.command, code)
        evidence = verdict.evidence
        jevMs += verdict.ms
        if (verdict.safe < COMPOSE_THRESHOLDS.safe) {
          return {
            ok: false,
            error:
              'El JEV no lo da por seguro: toca archivos, la red o el sistema sin que la orden lo pida.',
            attempts: attempt,
            evidence,
            jevMs,
          }
        }
        if (verdict.fulfils >= COMPOSE_THRESHOLDS.fulfils) {
          return {
            ok: true,
            code,
            say: value.say.trim().slice(0, MAX_SAY),
            attempts: attempt,
            evidence,
            jevMs,
          }
        }
        error = 'No hace todo lo que pide la orden, o lo deja a medias.'
      }
    }
    prompt = `${base}\n\nTu respuesta anterior no vale: ${error}\nLa respuesta era:\n${raw}\n\nDevuelve el JSON corregido.`
  }
  return { ok: false, error, attempts: COMPOSE_ATTEMPTS, evidence, jevMs }
}
