import { extractJson } from '../ai/json.ts'
import type { AiProvider } from '../ai/provider.ts'
import type { Decider } from './client.ts'
import { decideCommand, type Directive, type EngineInput, type Evidence } from './engine.ts'

/**
 * Preguntar bien. Cuando el JEV no tiene claro qué se pide, la pregunta de plantilla («¿Qué quieres
 * hacer?») sirve de poco: no sabe de qué programa se habla ni qué dijo el usuario.
 *
 * Aquí las dos herramientas se turnan otra vez:
 * - la **IA generativa** lee la orden, el programa y las dudas del JEV, y redacta una pregunta concreta
 *   con dos a cuatro salidas, cada una escrita como una orden completa («Cambiar `sumar` para que reste»);
 * - el **JEV** comprueba cada salida: se la pasa al motor como si el usuario la hubiera dicho, y solo se
 *   ofrecen las que el motor sabe cumplir sin volver a dudar. Una opción que llevaría a otra pregunta no
 *   se enseña.
 *
 * Si no queda ninguna opción que valga (o no hay IA), se queda la pregunta de plantilla.
 */

export const MAX_OPTIONS = 4

interface Proposal {
  question: string
  options: { label: string; order: string }[]
}

export function askSystem(): string {
  return [
    'Un editor de diagramas de programas en Python recibe órdenes habladas. Ha recibido una que no sabe cómo cumplir: es ambigua, le falta un dato o no encaja con el programa.',
    'Tu trabajo es preguntarle al usuario lo que falta, de forma concreta y breve, como lo haría un compañero que está mirando el mismo programa: nombra las cosas del programa por su nombre.',
    `Devuelve SOLO un objeto JSON: {"question": "…", "options": [{"label": "…", "order": "…"}]}, con entre 2 y ${MAX_OPTIONS} opciones.`,
    '«question»: una sola frase, en español, que diga qué no quedó claro. Nada de «¿puedes aclarar?»: di la duda.',
    '«label»: lo que se lee en el botón, de dos a seis palabras.',
    '«order»: la orden completa y sin ambigüedad que se ejecutaría al elegir esa opción, como si el usuario la dijera entera («añade un bucle para cada dentro de la función entrenar»). Tiene que poder cumplirse sobre este programa.',
    'Las opciones deben ser las lecturas más probables de lo que quiso decir, distintas entre sí. No inventes cosas que el programa no tiene.',
  ].join('\n')
}

export function askPrompt(request: {
  command: string
  context: string
  doubt: string
  evidence: readonly Evidence[]
  selected?: string
}): string {
  return [
    `Lo que dijo el usuario: ${request.command}`,
    `Por qué no se pudo cumplir: ${request.doubt}`,
    request.evidence.length > 0
      ? `Lo que entendió el motor (con su certeza): ${request.evidence
          .map(
            (item) => `${item.question} = ${item.answer} (${Math.round(item.confidence * 100)} %)`,
          )
          .join('; ')}`
      : '',
    request.selected
      ? `Lo que tiene seleccionado: ${request.selected}`
      : 'No tiene nada seleccionado.',
    request.context,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

function proposalOf(value: unknown): Proposal | null {
  if (typeof value !== 'object' || value === null) return null
  const { question, options } = value as { question?: unknown; options?: unknown }
  if (typeof question !== 'string' || question.trim() === '' || !Array.isArray(options)) return null
  const clean = options.flatMap((option) => {
    const { label, order } = (option ?? {}) as { label?: unknown; order?: unknown }
    if (typeof label !== 'string' || typeof order !== 'string') return []
    const text = order.trim()
    return label.trim() === '' || text === '' || text.length > 300
      ? []
      : [{ label: label.trim().slice(0, 48), order: text }]
  })
  return clean.length === 0 ? null : { question: question.trim().slice(0, 200), options: clean }
}

export interface AskRequest {
  input: EngineInput
  /** El contexto del programa, ya preparado. */
  context: string
  /** Lo que el motor contestó: una pregunta de plantilla, o por qué no pudo. */
  directive: Extract<Directive, { kind: 'ask' | 'unknown' }>
  evidence: readonly Evidence[]
  selected?: string
}

/**
 * Una pregunta mejor que la de plantilla, con salidas que el motor sabe cumplir. `null` si no hay nada
 * mejor que ofrecer.
 */
export async function smartAsk(
  provider: AiProvider,
  decider: Decider,
  request: AskRequest,
): Promise<Extract<Directive, { kind: 'ask' }> | null> {
  const { input, directive } = request
  let raw: string
  try {
    raw = await provider.generate({
      system: askSystem(),
      prompt: askPrompt({
        command: input.text,
        context: request.context,
        doubt: directive.kind === 'ask' ? directive.question : directive.say,
        evidence: request.evidence,
        ...(request.selected ? { selected: request.selected } : {}),
      }),
      maxTokens: 500,
    })
  } catch {
    return null
  }
  const extracted = extractJson(raw)
  const proposal = extracted.ok ? proposalOf(extracted.value) : null
  if (!proposal) return null
  // El JEV filtra: cada salida se decide como si se hubiera dicho. Las que no llevan a hacer algo, fuera.
  const checked = await Promise.all(
    proposal.options.slice(0, MAX_OPTIONS).map(async (option) => {
      try {
        const { directive: would } = await decideCommand(
          { ...input, text: option.order, forced: {}, single: true },
          decider,
        )
        return would.kind === 'do' ? option : null
      } catch {
        return null
      }
    }),
  )
  const options = checked.filter((option) => option !== null)
  if (options.length === 0) return null
  return { kind: 'ask', question: proposal.question, options }
}
