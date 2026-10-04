import type { Program } from '@prysel/python'
import type { Lesson } from '../lesson.ts'
import type { Trace } from '../trace.ts'
import { generateLesson } from './generate.ts'
import { extractJson } from './json.ts'
import type { AiProvider } from './provider.ts'

/**
 * «Explicar un tema» (la segunda entrada de la Fase D, la que no parte de un archivo que ya existe): la
 * IA escribe primero un programa pequeño y determinista que lo ilustre, se ejecuta en modo seguro
 * (`packages/extension/runtime/prysel_runner.py`, `SAFE_MODULES`) para grabar su traza real, y sobre esa
 * traza se narra el guion igual que en «Explicar este archivo» (`generate.ts`, que ya sabe reparar sola
 * su parte). Puro salvo por lo que le pasa la extensión (pedir al modelo, analizar el código, trazarlo):
 * fácil de probar sin IA ni Python de verdad.
 *
 *   tema + nivel → código (JSON: title + code) → se analiza y se traza EN MODO SEGURO
 *                → si el código falla (no compila, revienta, toca algo prohibido) se repara (máx. 3)
 *                → con la traza real, generateLesson narra el guion (con su propia reparación)
 */

/**
 * La misma lista que `SAFE_MODULES` en el motor (`prysel_runner.py`): si una cambia, cambiar la otra.
 * Deliberadamente corta: lo justo para explicar algoritmos y estructuras de datos.
 */
export const SAFE_MODULES = [
  'math',
  'random',
  'itertools',
  'functools',
  'collections',
  'dataclasses',
  'typing',
  'string',
  'statistics',
  'fractions',
  'decimal',
  'enum',
  're',
  'heapq',
  'bisect',
  'copy',
  'operator',
  'textwrap',
] as const

export const CODE_MAX_LINES = 40
/** Un intento inicial y como mucho dos reparaciones, igual que la narración. */
export const CODE_MAX_ATTEMPTS = 3
/** Con código de hasta 40 líneas y sin entrada, de sobra para que termine sin cortarse a medias. */
export const TOPIC_TRACE_LIMIT = 3000

export interface TopicOptions {
  /** El tema a explicar: «recursión», «ordenar con burbuja», «una pila con listas»… */
  topic: string
  level?: string
  lang?: string
  /** El nombre de archivo con el que se guardará (para el prompt y el campo `source` del guion). */
  source?: string
}

type CodeResult = { ok: true; title: string; code: string } | { ok: false; error: string }

/** Lo mínimo antes de gastar una ejecución: que sea JSON con forma, corto, y sin pedir entrada. */
function validateCode(value: unknown): CodeResult {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'La respuesta no es un objeto JSON.' }
  }
  const obj = value as Record<string, unknown>
  const title = obj['title']
  const code = obj['code']
  if (typeof title !== 'string' || title.trim() === '') {
    return { ok: false, error: 'Falta "title" (un título corto para el programa).' }
  }
  if (typeof code !== 'string' || code.trim() === '') {
    return { ok: false, error: 'Falta "code" (el programa Python entero).' }
  }
  const lines = code.split(/\r?\n/).length
  if (lines > CODE_MAX_LINES) {
    return {
      ok: false,
      error: `El programa tiene ${lines} líneas; como mucho ${CODE_MAX_LINES}, para que quepa en un diagrama.`,
    }
  }
  if (/\binput\s*\(/.test(code)) {
    return { ok: false, error: 'El programa usa «input()»: tiene que correr solo, sin pedir nada.' }
  }
  return { ok: true, title: title.trim(), code }
}

/** Lo que el modelo debe cumplir al escribir el código: el modo seguro, en sus propias palabras. */
export function buildCodeSystemPrompt(): string {
  return [
    'Escribes un programa Python pequeño para explicar un tema (de programación, o cualquier otro que se',
    'modele con código), que después se traza de verdad y se explica paso a paso sobre esa traza.',
    'Respondes solo este JSON:',
    '',
    '{ "title": "un título corto para el programa", "code": "el programa Python entero" }',
    '',
    'Reglas, todas obligatorias:',
    '1. Responde solo el JSON. Sin explicación, sin marcado, sin ```.',
    `2. Como mucho ${CODE_MAX_LINES} líneas.`,
    '3. Determinista y que corre solo hasta el final, sin ninguna entrada: nada de `input()`, nada que',
    '   dependa del reloj, de la red o del sistema de archivos. Si usas `random`, fija la semilla con',
    '   `random.seed(N)` (un número cualquiera) en la primera línea que lo use.',
    `4. Solo puedes importar: ${SAFE_MODULES.join(', ')}. Nada de archivos, red, procesos, hilos, ni`,
    '   `exec`/`eval`/`compile`/`open`/`__import__`: el motor los rechaza antes de ejecutar una sola línea.',
    '5. El programa tiene que TERMINAR solo (nada de bucles sin condición de salida) e imprimir con',
    '   `print(...)` lo que haga falta para ver que hizo su trabajo.',
    '6. Que el tema se note en el código: nombres de variables y funciones que hablen de él, no `a`, `b`, `f`.',
    '7. Si una función (o el programa) hace el trabajo en fases (preparar, repetir, decidir, resumir…),',
    '   empieza cada fase con un comentario de sección tras una línea en blanco, `# Nombre: qué hace`, y',
    '   pon al menos dos en ese bloque: Prysel dibuja cada fase como una etapa que se abre. No comentes',
    '   cada línea.',
  ].join('\n')
}

export function buildCodeUserPrompt(options: TopicOptions): string {
  return [
    `Tema: ${options.topic}`,
    options.level ? `Nivel: ${options.level}` : null,
    '',
    'Escribe el programa que mejor lo explique con su propia ejecución (no hace falta que comentes cada',
    'línea: la explicación va aparte, sobre lo que de verdad pasó al ejecutarlo; basta con nombrar sus fases).',
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

/** Tras un código que no vale: se le dice el motivo exacto (el mismo formato que la narración). */
export function buildCodeRepairPrompt(
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

export interface GenerateTopicResult {
  ok: boolean
  title?: string
  code?: string
  lesson?: Lesson
  /** Por qué no valió (del código o, si el código valió, del guion), si no valió. */
  error?: string
  /** Cuántos intentos costó el CÓDIGO (la narración tiene los suyos, aparte, en `generateLesson`). */
  attempts: number
  /** Lo último que devolvió el modelo para el código, si nunca llegó a valer. */
  raw?: string
}

/** Lo que la extensión pone (analizar y ejecutar), para que esto se pruebe sin IA ni Python de verdad. */
export interface TopicRuntime {
  /** El mismo parser que usa el lienzo. Lanza si el texto no es Python válido. */
  parse: (code: string) => Program
  /** Lo ejecuta EN MODO SEGURO y graba su traza real: la verdad sobre la que se narra después. */
  trace: (code: string) => Promise<Trace>
}

export async function generateTopic(
  provider: AiProvider,
  runtime: TopicRuntime,
  options: TopicOptions,
): Promise<GenerateTopicResult> {
  const system = buildCodeSystemPrompt()
  let prompt = buildCodeUserPrompt(options)
  let lastRaw = ''
  let lastError = 'El modelo no respondió.'

  for (let attempt = 1; attempt <= CODE_MAX_ATTEMPTS; attempt++) {
    let raw: string
    try {
      raw = await provider.generate({ system, prompt, maxTokens: 1500 })
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
      prompt = buildCodeRepairPrompt(prompt, raw, lastError)
      continue
    }
    const validated = validateCode(extracted.value)
    if (!validated.ok) {
      lastError = validated.error
      prompt = buildCodeRepairPrompt(prompt, raw, lastError)
      continue
    }

    let program: Program
    try {
      program = runtime.parse(validated.code)
    } catch (error) {
      lastError = `El código no se pudo analizar: ${error instanceof Error ? error.message : String(error)}`
      prompt = buildCodeRepairPrompt(prompt, raw, lastError)
      continue
    }

    let trace: Trace
    try {
      trace = await runtime.trace(validated.code)
    } catch (error) {
      lastError = `El código no se pudo ejecutar: ${error instanceof Error ? error.message : String(error)}`
      prompt = buildCodeRepairPrompt(prompt, raw, lastError)
      continue
    }
    if (trace.error) {
      const where = trace.error.line !== null ? `línea ${trace.error.line}` : 'no se sabe dónde'
      lastError = `El programa falló al ejecutarse (${where}): ${trace.error.name}: ${trace.error.message}`
      prompt = buildCodeRepairPrompt(prompt, raw, lastError)
      continue
    }

    // El código vale y ya tiene una traza real: ahora se narra, con la reparación de `generateLesson`.
    const narrated = await generateLesson(program, trace, provider, {
      source: options.source ?? options.topic,
      level: options.level,
      lang: options.lang,
    })
    if (!narrated.ok || !narrated.lesson) {
      return {
        ok: false,
        error: `El código valió, pero su guion no pasó la validación: ${narrated.error ?? ''}`,
        attempts: attempt,
        code: validated.code,
        title: validated.title,
      }
    }
    return {
      ok: true,
      title: validated.title,
      code: validated.code,
      lesson: narrated.lesson,
      attempts: attempt,
    }
  }
  return { ok: false, error: lastError, attempts: CODE_MAX_ATTEMPTS, raw: lastRaw }
}
