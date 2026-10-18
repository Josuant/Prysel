import type { AiProvider, AiRequest } from './ai/provider.ts'
import type { Decider, JevAnswer, JevQuestion, JevRequest } from './jev/client.ts'

/**
 * El registro de consultas: cada vez que Prysel le pregunta algo a un modelo —a la IA generativa que
 * redacta, o al JEV que decide— queda apuntado qué se le mandó y qué contestó, para poder verlo en el
 * lienzo (la pestaña «Consultas»). Es la forma de entender por qué hizo lo que hizo, y de comprobar qué
 * sale del equipo.
 *
 * Funciona envolviendo al proveedor y al decisor: quien los usa no cambia nada. Las claves no pasan por
 * aquí (viven en quien hace la llamada), así que nunca quedan apuntadas.
 */

export interface CallEntry {
  id: number
  /** Cuándo salió (milisegundos desde 1970). */
  at: number
  /** Quién contesta: la IA generativa que redacta, o el JEV que decide. */
  kind: 'ia' | 'jev'
  /** El modelo (`deepseek:deepseek-flash`, `jev-latest`, `local`). */
  model: string
  status: 'running' | 'done' | 'failed'
  /** Lo que tardó, cuando ya acabó. */
  ms?: number
  /** A la IA: sus instrucciones y la petición. */
  system?: string
  prompt?: string
  /** Al JEV: el estado y las preguntas (cada una con sus opciones). */
  state?: unknown
  questions?: { id: string; type: string; instructions: string; options?: string[] }[]
  /** Lo que contestó la IA (va creciendo mientras llega). */
  text?: string
  /** Lo que contestó el JEV a cada pregunta. */
  answers?: { id: string; answer: string; confidence: number }[]
  error?: string
}

/** Lo más que se guarda de un texto: una petición con un archivo enorme no debe ahogar el lienzo. */
export const MAX_CALL_TEXT = 30_000
/** Cuántas consultas se recuerdan. */
export const MAX_CALLS = 400
/** Mientras llega una respuesta, cada cuánto se avisa de cómo va. */
const STREAM_NOTIFY_MS = 200

const clip = (text: string) =>
  text.length > MAX_CALL_TEXT
    ? `${text.slice(0, MAX_CALL_TEXT)}\n… (${text.length - MAX_CALL_TEXT} caracteres más)`
    : text

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function questionsOf(questions: Record<string, JevQuestion>): NonNullable<CallEntry['questions']> {
  return Object.entries(questions).map(([id, question]) => ({
    id,
    type: question.type,
    instructions: question.instructions,
    ...(question.type === 'choice' ? { options: Object.keys(question.criteria) } : {}),
  }))
}

function answersOf(answers: Record<string, JevAnswer>): NonNullable<CallEntry['answers']> {
  return Object.entries(answers).map(([id, answer]) =>
    answer.type === 'noul'
      ? { id, answer: answer.noul >= 0.5 ? 'sí' : 'no', confidence: answer.noul }
      : { id, answer: answer.choice, confidence: answer.confidence },
  )
}

export class CallLog {
  private entries: CallEntry[] = []
  private seq = 0

  constructor(
    /** Una consulta empezó, avanzó o acabó. */
    private readonly onChange: (entry: CallEntry) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Las consultas recordadas, de la más antigua a la más reciente. */
  all(): readonly CallEntry[] {
    return this.entries
  }

  clear(): void {
    this.entries = []
  }

  private open(entry: Omit<CallEntry, 'id' | 'at' | 'status'>): CallEntry {
    const created: CallEntry = { ...entry, id: ++this.seq, at: this.now(), status: 'running' }
    this.entries.push(created)
    if (this.entries.length > MAX_CALLS) this.entries.splice(0, this.entries.length - MAX_CALLS)
    this.onChange(created)
    return created
  }

  private close(entry: CallEntry, change: Partial<CallEntry>): void {
    Object.assign(entry, change, { ms: Math.round(this.now() - entry.at) })
    this.onChange(entry)
  }

  /** El mismo proveedor, apuntando cada petición y su respuesta. */
  provider(inner: AiProvider): AiProvider {
    const start = (request: AiRequest) =>
      this.open({
        kind: 'ia',
        model: inner.id,
        system: clip(request.system),
        prompt: clip(request.prompt),
      })
    const stream = inner.stream?.bind(inner)
    return {
      id: inner.id,
      generate: async (request) => {
        const entry = start(request)
        try {
          const text = await inner.generate(request)
          this.close(entry, { status: 'done', text: clip(text) })
          return text
        } catch (error) {
          this.close(entry, { status: 'failed', error: messageOf(error) })
          throw error
        }
      },
      ...(stream
        ? {
            stream: async (
              request: AiRequest,
              onText: (delta: string) => void,
              signal?: AbortSignal,
            ) => {
              const entry = start(request)
              let seen = ''
              let told = this.now()
              try {
                const text = await stream(
                  request,
                  (delta) => {
                    seen += delta
                    // La respuesta se ve llegar, sin avisar por cada letra.
                    if (this.now() - told >= STREAM_NOTIFY_MS) {
                      told = this.now()
                      entry.text = clip(seen)
                      this.onChange(entry)
                    }
                    onText(delta)
                  },
                  signal,
                )
                this.close(entry, {
                  status: 'done',
                  text: clip(text || seen),
                  ...(signal?.aborted ? { error: 'Se detuvo antes de acabar.' } : {}),
                })
                return text
              } catch (error) {
                this.close(entry, { status: 'failed', text: clip(seen), error: messageOf(error) })
                throw error
              }
            },
          }
        : {}),
    }
  }

  /** El mismo decisor, apuntando cada pregunta y lo que contestó. */
  decider(inner: Decider): Decider {
    return {
      id: inner.id,
      decide: async (request: JevRequest) => {
        const entry = this.open({
          kind: 'jev',
          model: inner.id,
          state: request.state,
          questions: questionsOf(request.questions),
        })
        try {
          const response = await inner.decide(request)
          this.close(entry, { status: 'done', answers: answersOf(response.answers) })
          return response
        } catch (error) {
          this.close(entry, { status: 'failed', error: messageOf(error) })
          throw error
        }
      },
    }
  }
}
