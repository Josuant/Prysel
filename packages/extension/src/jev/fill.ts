import { TEMPLATES, type TemplateId } from '@prysel/morphology'
import type { Program, ProgramNode } from '@prysel/python'
import { templateLines } from '@prysel/python/edits'
import { extractJson } from '../ai/json.ts'
import type { AiProvider } from '../ai/provider.ts'

/**
 * El camino lento de una orden: escribir el **contenido** de la pieza que el JEV ya colocó.
 *
 * Jev decide la estructura (un bucle, aquí) en décimas de segundo, pero no escribe texto. El código de
 * dentro lo redacta la IA generativa que ya usa Prysel, en segundo plano, y no se acepta sin comprobar:
 * tiene que ser Python válido, una sola sentencia, y **la pieza que decidió el JEV** (un bucle sigue
 * siendo un bucle). Lo generado no cambia la estructura decidida; si no encaja, la plantilla se queda.
 *
 * Puro salvo por `provider.generate`: se prueba con un proveedor de mentira.
 */

/** Un intento y, si no vale, una reparación: lo que tarde de más ya no acompaña a la orden. */
export const FILL_ATTEMPTS = 2

/** Tope del código que se manda como contexto. */
const MAX_CONTEXT = 12_000
const MAX_LINES = 30
const MAX_SAY = 400

export interface FillRuntime {
  /** Analiza un Python suelto: el programa, y si tiene errores de sintaxis. */
  parse: (code: string) => { program: Program; hasError: boolean }
}

export interface FillRequest {
  /** La orden, tal como se dijo. */
  command: string
  template: TemplateId
  /** El programa, ya con la pieza colocada y marcada. */
  program: Program
  genId: string
}

export type FillResult =
  | { ok: true; code: string; say: string; attempts: number }
  | { ok: false; error: string; attempts: number }

/** Las plantillas que guardan un valor con un nombre: lo generado puede ser cualquier asignación. */
const VALUES: ReadonlySet<TemplateId> = new Set([
  'variable',
  'text',
  'boolean',
  'list',
  'dict',
  'operation',
  'call',
  'input',
])

/** Las palabras con las que empieza una sentencia compuesta: lo generado tiene que empezar con la misma. */
const KEYWORDS: ReadonlySet<string> = new Set(['for', 'while', 'if', 'try', 'with', 'def'])

export function buildFillSystem(): string {
  return [
    'Escribes el contenido de UNA pieza de un programa en Python que alguien está dictando a un editor de diagramas.',
    'La pieza ya está colocada en el programa como una plantilla, en la línea marcada con el comentario «# prysel:gen:…». Tú la sustituyes.',
    'Devuelve SOLO un objeto JSON, sin texto alrededor: {"code": "…", "say": "…"}.',
    '«code»: una única sentencia de Python del tipo pedido (si es compuesta, con su cuerpo), sin sangría inicial y con 4 espacios por nivel. Usa los nombres que ya existen en el programa cuando la orden se refiera a ellos. No repitas código de alrededor, no añadas comentarios y no pases de 12 líneas.',
    '«say»: una o dos frases cortas, en español y sin código, que expliquen qué hace la pieza. Se leerán en voz alta.',
  ].join('\n')
}

export function buildFillPrompt(request: FillRequest): string {
  const { template, program, genId, command } = request
  const node = program.nodes.find((n) => n.generating === genId)
  const source =
    program.source.length > MAX_CONTEXT
      ? contextAround(program.source, node?.line ?? 1)
      : program.source
  return [
    `Orden: ${command}`,
    `Tipo de pieza: ${TEMPLATES[template].label} (${TEMPLATES[template].hint}).`,
    `Su plantilla, que debes sustituir:\n${templateLines(template).join('\n')}`,
    node?.scope?.length ? `Nombres que puede usar ahí: ${node.scope.join(', ')}.` : '',
    `El programa (la pieza es la línea marcada con «# prysel:gen:${genId}»):\n${source}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

/** Las líneas de alrededor de la pieza, cuando el archivo es demasiado largo para mandarlo entero. */
function contextAround(source: string, line: number): string {
  const lines = source.split(/\r?\n/)
  const from = Math.max(0, line - 80)
  return lines.slice(from, line + 40).join('\n')
}

const topLevel = (program: Program): ProgramNode[] =>
  program.nodes.filter((node) => node.range !== undefined && node.range.owner === undefined)

/** ¿Es lo generado la pieza que se decidió? Devuelve por qué no, o `null` si vale. */
export function checkFill(runtime: FillRuntime, template: TemplateId, code: string): string | null {
  if (code.trim() === '') return 'El código está vacío.'
  if (code.split(/\r?\n/).length > MAX_LINES) return `El código pasa de ${MAX_LINES} líneas.`
  if (/^[ \t]/.test(code)) return 'El código no debe empezar con sangría.'
  if (/prysel:gen:/.test(code)) return 'El código no debe llevar la marca «prysel:gen».'
  const parsed = runtime.parse(code)
  if (parsed.hasError) return 'El código no es Python válido.'
  const statements = topLevel(parsed.program)
  if (statements.length !== 1) {
    return `Debe ser una única sentencia y hay ${statements.length}.`
  }
  const [made] = statements
  if (VALUES.has(template)) {
    return made?.provides !== undefined || (made?.results?.length ?? 0) > 0
      ? null
      : 'Debe ser una asignación: guardar un valor con un nombre.'
  }
  // Lo demás (un bucle, una decisión, imprimir…) tiene que ser del mismo tipo que su plantilla.
  const model = templateLines(template).join('\n')
  const expected = topLevel(runtime.parse(model).program)[0]?.kind
  // Un `for` y un `while` son los dos un bucle: los distingue la palabra con la que empiezan.
  const keyword = (text: string) => /^[a-z]+/.exec(text)?.[0]
  const sameWord = !KEYWORDS.has(keyword(model) ?? '') || keyword(code) === keyword(model)
  return made?.kind === expected && sameWord
    ? null
    : `Debe ser «${TEMPLATES[template].label}», como la plantilla, y es otra cosa.`
}

export async function generateFill(
  provider: AiProvider,
  runtime: FillRuntime,
  request: FillRequest,
): Promise<FillResult> {
  const system = buildFillSystem()
  const base = buildFillPrompt(request)
  let prompt = base
  let error = 'El modelo no respondió.'
  for (let attempt = 1; attempt <= FILL_ATTEMPTS; attempt++) {
    let raw: string
    try {
      raw = await provider.generate({ system, prompt, maxTokens: 800 })
    } catch (failure) {
      return {
        ok: false,
        error: `El modelo no respondió: ${failure instanceof Error ? failure.message : String(failure)}`,
        attempts: attempt,
      }
    }
    const extracted = extractJson(raw)
    const value = extracted.ok ? (extracted.value as { code?: unknown; say?: unknown }) : null
    if (!extracted.ok) error = extracted.error
    else if (typeof value?.code !== 'string' || typeof value.say !== 'string') {
      error = 'Faltan «code» o «say» (dos textos).'
    } else {
      const code = value.code.replace(/\r\n/g, '\n').replace(/\s+$/, '')
      const problem = checkFill(runtime, request.template, code)
      if (problem === null) {
        return { ok: true, code, say: value.say.trim().slice(0, MAX_SAY), attempts: attempt }
      }
      error = problem
    }
    prompt = `${base}\n\nTu respuesta anterior no vale: ${error}\nLa respuesta era:\n${raw}\n\nDevuelve el JSON corregido.`
  }
  return { ok: false, error, attempts: FILL_ATTEMPTS }
}

/** Explicar un elemento que ya existe: una o dos frases para leer en voz alta. */
export async function explainNode(
  provider: AiProvider,
  program: Program,
  node: ProgramNode,
): Promise<string | null> {
  const source =
    program.source.length > MAX_CONTEXT ? contextAround(program.source, node.line) : program.source
  try {
    const raw = await provider.generate({
      system:
        'Explicas, a quien está aprendiendo a programar, qué hace una parte de un programa en Python. ' +
        'Responde con una o dos frases cortas en español, sin código ni formato: se leerán en voz alta.',
      prompt: `Explica la sentencia de la línea ${node.line}:\n${node.text ?? node.code}\n\nEl programa:\n${source}`,
      maxTokens: 300,
    })
    const said = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_SAY)
    return said === '' ? null : said
  } catch {
    return null
  }
}
