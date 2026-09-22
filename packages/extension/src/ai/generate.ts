import type { Program } from '@prysel/python'
import type { Lesson } from '../lesson.ts'
import type { Trace } from '../trace.ts'
import {
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  type GenerateOptions,
} from './prompt.ts'
import { normalizeAiJson } from './normalize.ts'
import type { AiProvider } from './provider.ts'
import { validateGenerated } from './validate.ts'

/**
 * Pide una lección al modelo sobre el programa y su traza real, y no se la queda hasta que pasa la
 * validación: si falla, se le dice el motivo exacto y se le pide que lo corrija, hasta dos veces. Puro
 * salvo por `provider.generate` (la única llamada de red): fácil de probar con un proveedor de mentira.
 */

/** Un intento inicial y como mucho dos reparaciones, como dice el diseño. */
export const MAX_ATTEMPTS = 3

export interface GenerateResult {
  ok: boolean
  lesson?: Lesson
  /** Por qué no valió, si no valió. */
  error?: string
  attempts: number
  /** Lo último que devolvió el modelo, para depurar un fallo que no se pudo corregir. */
  raw?: string
}

type Extracted = { ok: true; value: unknown } | { ok: false; error: string }

/** Un modelo a veces envuelve el JSON en una valla de código: se quita antes de parsear. */
function extractJson(text: string): Extracted {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const body = fenced?.[1] ?? trimmed
  try {
    return { ok: true, value: JSON.parse(body) }
  } catch (error) {
    return {
      ok: false,
      error: `La respuesta no es JSON válido: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function generateLesson(
  program: Program,
  trace: Trace,
  provider: AiProvider,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const system = buildSystemPrompt()
  let prompt = buildUserPrompt(program, trace, options)
  let lastRaw = ''
  let lastError = 'El modelo no respondió.'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string
    try {
      raw = await provider.generate({ system, prompt, maxTokens: 4000 })
    } catch (error) {
      return {
        ok: false,
        error: `El modelo no respondió: ${error instanceof Error ? error.message : String(error)}`,
        attempts: attempt,
      }
    }
    lastRaw = raw

    const extracted = extractJson(raw)
    if (!extracted.ok) {
      lastError = extracted.error
      prompt = buildRepairPrompt(prompt, raw, lastError)
      continue
    }
    const validated = validateGenerated(program, trace, normalizeAiJson(extracted.value))
    if (validated.ok) return { ok: true, lesson: validated.lesson, attempts: attempt }
    lastError = validated.error
    prompt = buildRepairPrompt(prompt, raw, lastError)
  }
  return { ok: false, error: lastError, attempts: MAX_ATTEMPTS, raw: lastRaw }
}
