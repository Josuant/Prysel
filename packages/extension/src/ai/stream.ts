import type { AiProvider, AiRequest } from './provider.ts'

/**
 * Leer una respuesta a medida que llega (SSE: líneas `data: {…}`), para los proveedores que hablan HTTP.
 * `pick` saca de cada evento el trozo de texto que trae (o nada). Devuelve el texto entero al acabar.
 * Si se corta (`signal`), deja de leer y devuelve lo que llevaba.
 */
export async function readEventStream(
  response: Response,
  pick: (event: unknown) => string | undefined,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  const take = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (data === '' || data === '[DONE]') return
    try {
      const delta = pick(JSON.parse(data))
      if (delta) {
        text += delta
        onText(delta)
      }
    } catch {
      // Un evento que no es JSON (un comentario, un latido) no trae texto.
    }
  }
  try {
    for (;;) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) take(line)
    }
    take(buffer)
  } catch (error) {
    // Cortar a mitad no es un fallo: se devuelve lo leído.
    if (!signal?.aborted) throw error
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  return text
}

/**
 * Pide un texto viéndolo llegar. Con un proveedor que no sabe ir por trozos, llega entero al final: quien
 * lo usa no tiene que distinguir.
 */
export async function streamText(
  provider: AiProvider,
  request: AiRequest,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (provider.stream) return provider.stream(request, onText, signal)
  const text = await provider.generate(request)
  if (!signal?.aborted) onText(text)
  return text
}
