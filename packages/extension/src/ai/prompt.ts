import type { Program } from '@prysel/python'
import { NOTE_STYLE_IDS } from '../lesson.ts'
import type { Trace, TraceEvent } from '../trace.ts'
import { anchorKey } from '../anchor.ts'
import { formatShown } from '../../webview/src/player.ts'
import { INSIGHTS } from '../../webview/src/insights.ts'

/**
 * Los textos que se le piden al modelo: la lista de sentencias con las que puede anclar una nota, un
 * resumen legible de la traza real (para que narre sobre hechos, no invenciones) y las instrucciones del
 * formato. Puro: nada de red ni de `vscode` aquí, para poder probarlo sin llamar a ningún modelo.
 */

export interface GenerateOptions {
  /** El nombre del archivo, para el título por defecto y el campo `source`. */
  source: string
  /** «para quien empieza», «para quien ya sabe recursión»… libre. */
  level?: string
  /** Código de idioma de las notas (`es` por defecto). */
  lang?: string
}

/** Cuántos pasos de la traza se le enseñan al modelo como mucho: de sobra para un programa de clase. */
export const TRACE_EVENT_LIMIT = 400

/** Lo que valen los argumentos o las variables que cambiaron, en una línea legible. */
function changesOf(event: TraceEvent): string {
  return Object.entries(event.ch ?? {})
    .map(([name, value]) => `${name}=${formatShown(value)}`)
    .join(', ')
}

/** Una línea de la traza, para que el modelo narre sobre hechos y no sobre lo que cree que pasa. */
function eventLine(event: TraceEvent): string {
  const changes = changesOf(event)
  const parts: string[] = []
  switch (event.k) {
    case 'call':
      parts.push(`L${event.l}: entra en ${event.fn ?? '?'}(${changes})`)
      break
    case 'return':
      parts.push(`L${event.l}: devuelve ${formatShown(event.v ?? null)}`)
      break
    case 'exception':
      parts.push(`L${event.l}: lanza ${event.e ?? 'un error'}`)
      break
    case 'end':
      parts.push(`L${event.l}: el programa termina`)
      break
    default:
      parts.push(changes ? `L${event.l}: ${changes}` : `L${event.l}`)
  }
  if (event.o) parts.push(`(imprime ${JSON.stringify(event.o)})`)
  return parts.join(' ')
}

/** La lista de sentencias del programa: lo único que se puede usar como `at.text` o `when.text`. */
export function statementList(program: Program): string {
  return [...program.nodes]
    .filter((node) => (node.text ?? node.code).trim() !== '')
    .sort((a, b) => a.line - b.line)
    .map((node) => `L${node.line}: ${anchorKey(node)}`)
    .join('\n')
}

/** Un resumen legible de la traza, con tope: la verdad sobre la que se narra, no lo que el modelo suponga. */
export function traceSummary(trace: Trace, limit = TRACE_EVENT_LIMIT): string {
  if (trace.events.length === 0) return '(sin pasos)'
  const shown = trace.events.slice(0, limit).map(eventLine).join('\n')
  const rest = trace.events.length - limit
  return rest > 0 ? `${shown}\n… (se cortó aquí: ${rest} pasos más)` : shown
}

/** Lo que el modelo debe cumplir siempre, con el formato exacto del guion. */
export function buildSystemPrompt(): string {
  return [
    'Generas el guion de una lección para Prysel, una extensión de VS Code que dibuja un programa Python',
    'como un diagrama y lo explica paso a paso. El guion es un JSON con este formato exacto:',
    '',
    '{',
    '  "version": 1,',
    '  "title": "string",',
    '  "level": "string (opcional)",',
    '  "lang": "string (opcional, código de idioma)",',
    '  "source": "string (opcional, el nombre del archivo)",',
    `  "show": ["opcional, algunos de: ${INSIGHTS.join(', ')}"],`,
    '  "beats": [',
    '    {',
    '      "id": "string corto, único",',
    '      "at": { "text": "el texto EXACTO de una sentencia de la lista", "nth": "opcional, entero desde 1" },',
    '      "when": { "text": "...", "nth": "...", "visit": "opcional, entero desde 1: qué vez se cuenta" },',
    '      "note": {',
    `        "style": "una de: ${NOTE_STYLE_IDS.join(', ')}",`,
    '        "title": "opcional, corto",',
    '        "text": "lo que se explica; admite **negrita** y `código` en línea"',
    '      },',
    '      "ask": {',
    '        "text": "una pregunta, opcional",',
    '        "expect": "value o output",',
    '        "name": "el nombre de la variable, si expect es value"',
    '      }',
    '    }',
    '  ]',
    '}',
    '',
    'Reglas, todas obligatorias:',
    '1. Responde solo el JSON. Sin explicación, sin marcado, sin ```.',
    '2. "at.text" (y "when.text" si lo usas) tiene que ser, letra por letra, uno de los textos de la lista',
    '   de sentencias que se te da (o el principio de uno, hasta los dos puntos de una cabecera). Nunca',
    '   inventes una sentencia que no esté en la lista.',
    '3. Cada nota describe lo que la traza muestra de verdad: valores, llamadas, lo impreso. Nunca lo que',
    '   "normalmente pasaría" o lo que el código "debería" hacer si la traza dice otra cosa.',
    '4. Si usas "when" con "visit" mayor que 1, esa sentencia tiene que ejecutarse esa cantidad de veces en',
    '   la traza (cuéntalas en la lista de pasos).',
    '5. Una pregunta ("ask") de tipo "value" solo sobre un nombre que de verdad exista en ese punto de la',
    '   traza; formúlala sobre algo que pase justo en esa sentencia (no algo ya sabido de antes).',
    '6. Entre 3 y 8 momentos: ni una sola nota para todo el programa, ni una por cada línea.',
    '7. "show" son los nodos que ayudan a entender ESTE programa (por ejemplo "stack" y "tree" si hay',
    '   recursión, "collection" si se ordena o recorre una lista, "memory" si hay alias). Como mucho 3.',
    '8. "style", "expect" y cada entrada de "show" son códigos fijos, siempre en inglés y tal cual están',
    '   escritos arriba (minúsculas, sin acentos): NUNCA los traduzcas al idioma de las notas, aunque',
    `   "text", "title" y "note" sí vayan en ese idioma. Por ejemplo "value" y "output", nunca "valor" o`,
    '   "salida".',
    '',
    'Un ejemplo de un momento bien formado (con el estilo, "expect" y "show" tal cual, en inglés):',
    '{',
    '  "version": 1,',
    '  "title": "Un ejemplo",',
    '  "show": ["stack"],',
    '  "beats": [',
    '    { "id": "b1", "at": { "text": "total = 0" },',
    '      "note": { "style": "sticky", "text": "Se empieza en `0`." },',
    '      "ask": { "text": "¿Cuánto vale total?", "expect": "value", "name": "total" } }',
    '  ]',
    '}',
  ].join('\n')
}

/** El pedido concreto: el programa (como lista de sentencias) y su traza real. */
export function buildUserPrompt(program: Program, trace: Trace, options: GenerateOptions): string {
  return [
    `Archivo: ${options.source}`,
    options.level ? `Nivel: ${options.level}` : null,
    `Idioma de las notas: ${options.lang ?? 'es'}`,
    '',
    'Sentencias del programa (una por línea, "L<línea>: <texto>"):',
    statementList(program),
    '',
    'Traza real de una ejecución (una por paso; es la única verdad sobre lo que pasa):',
    traceSummary(trace),
    '',
    'Genera el guion.',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

/** Tras una respuesta que no vale: se le dice el motivo exacto y se le pide que corrija solo eso. */
export function buildRepairPrompt(
  previousPrompt: string,
  previousResponse: string,
  error: string,
): string {
  return [
    previousPrompt,
    '',
    'Tu respuesta anterior fue:',
    previousResponse,
    '',
    `No vale: ${error}`,
    'Corrige solo lo necesario y responde de nuevo con el JSON completo (las mismas reglas de antes).',
  ].join('\n')
}
