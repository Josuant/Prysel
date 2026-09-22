/**
 * Un modelo a veces envuelve el JSON en una valla de código, o lo rodea de texto: se rescata antes de
 * parsear. Compartido por la generación de guiones y la de código (Fase D), para que ambas acepten lo
 * mismo y fallen con el mismo mensaje.
 */

export type Extracted = { ok: true; value: unknown } | { ok: false; error: string }

export function extractJson(text: string): Extracted {
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
