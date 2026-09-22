/**
 * El guion de una lección: lo que se cuenta sobre un programa y cuándo. Vive en un `.lesson.json` junto al
 * `.py` (el código no se ensucia con metadatos) y se puede escribir a mano: el formato no depende de la IA.
 *
 * Puro: sin `vscode` ni motor. Aquí se valida (el archivo lo puede escribir cualquiera, y lo que llega de
 * fuera es dato, no confianza) y se normaliza; qué nodo es cada ancla se resuelve en el webview, que es
 * donde está el programa analizado.
 */

/** Las clases de nota. Deben coincidir con las que sabe dibujar el lienzo (`@prysel/ui`, `NOTE_STYLES`). */
export const NOTE_STYLE_IDS = [
  'sticky',
  'callout',
  'warning',
  'definition',
  'analogy',
  'margin',
] as const
export type NoteStyleId = (typeof NOTE_STYLE_IDS)[number]

/**
 * Dónde: una sentencia por el texto que tiene (como los visores: la sigue aunque se mueva de línea), y cuál
 * de las que tienen ese texto (`nth`, base 1; por defecto la primera).
 */
export interface Anchor {
  text: string
  nth?: number
}

/** Los nodos para entender que sabe dibujar el lienzo. Deben coincidir con `INSIGHTS` del webview. */
export const INSIGHT_IDS = ['variables', 'stack', 'tree', 'memory', 'collection'] as const
export type InsightIdentifier = (typeof INSIGHT_IDS)[number]

/**
 * Una pregunta antes de ver lo que pasa: «¿qué valdrá `total` tras esta línea?» (`value`, con el nombre) o
 * «¿qué imprimirá?» (`output`). Se responde al llegar al momento y luego se revela con la traza.
 */
export interface Ask {
  text: string
  expect: 'value' | 'output'
  /** La variable por la que se pregunta, si se espera un valor. */
  name?: string
}

export interface Beat {
  id: string
  /** El nodo al que se refiere la nota: de él sale la flecha. */
  at: Anchor
  /**
   * El momento de la ejecución en el que se cuenta: la vez `visit` (base 1; por defecto la primera) que el
   * programa llega a esta sentencia. Sin él, es la de `at`.
   */
  when?: Anchor & { visit?: number }
  note: { text: string; style: NoteStyleId; title?: string }
  ask?: Ask
}

export interface Lesson {
  version: 1
  title: string
  level?: string
  lang?: string
  /** El archivo del programa, tal como lo llama el guion (informativo). */
  source?: string
  /** Qué nodos para entender se enseñan al abrir la lección (el alumno puede cambiarlos). */
  show?: InsightIdentifier[]
  beats: Beat[]
}

export const LESSON_LIMITS = {
  beats: 200,
  title: 200,
  text: 2000,
  anchor: 300,
  meta: 60,
  /** El guion entero, en caracteres: por encima, se descarta antes de mirarlo. */
  file: 512_000,
}

export type LessonResult = { ok: true; lesson: Lesson } | { ok: false; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fail = (error: string): LessonResult => ({ ok: false, error })

/** Un texto con límite; `undefined` si falta, y `null` si está pero no es válido. */
function text(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) return null
  return value
}

function anchor(value: unknown, where: string): Anchor | string {
  if (!isRecord(value)) return `${where}: falta el ancla`
  const at = text(value['text'], LESSON_LIMITS.anchor)
  if (!at || at.trim() === '') return `${where}: el ancla necesita un texto (el de la sentencia)`
  const nth = value['nth']
  if (nth !== undefined && (!Number.isInteger(nth) || (nth as number) < 1)) {
    return `${where}: «nth» es un entero desde 1`
  }
  return { text: at, ...(nth === undefined ? {} : { nth: nth as number }) }
}

/** Valida y normaliza un guion. Lo que no reconoce lo ignora; lo que está mal dicho lo rechaza con su motivo. */
export function parseLesson(value: unknown): LessonResult {
  if (!isRecord(value)) return fail('El guion debe ser un objeto JSON.')
  if (value['version'] !== 1) return fail('Versión de guion desconocida (se esperaba 1).')
  const title = text(value['title'], LESSON_LIMITS.title)
  if (!title) return fail('El guion necesita un título.')
  const level = text(value['level'], LESSON_LIMITS.meta)
  const lang = text(value['lang'], LESSON_LIMITS.meta)
  const source = text(value['source'], LESSON_LIMITS.anchor)
  if (level === null || lang === null || source === null) return fail('Datos del guion no válidos.')
  let show: InsightIdentifier[] | undefined
  if (value['show'] !== undefined) {
    const listed = value['show']
    if (
      !Array.isArray(listed) ||
      listed.length > INSIGHT_IDS.length ||
      !listed.every((id) => INSIGHT_IDS.includes(id as InsightIdentifier))
    ) {
      return fail(`«show» es una lista de: ${INSIGHT_IDS.join(', ')}.`)
    }
    show = [...new Set(listed as InsightIdentifier[])]
  }
  const raw = value['beats']
  if (!Array.isArray(raw)) return fail('«beats» debe ser una lista.')
  if (raw.length > LESSON_LIMITS.beats)
    return fail(`Demasiados momentos (máximo ${LESSON_LIMITS.beats}).`)

  const beats: Beat[] = []
  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const where = `Momento ${index + 1}`
    if (!isRecord(entry)) return fail(`${where}: debe ser un objeto.`)
    const given = text(entry['id'], LESSON_LIMITS.meta)
    if (given === null) return fail(`${where}: «id» no válido.`)
    const id = given === undefined || given === '' ? `b${index + 1}` : given
    if (seen.has(id)) return fail(`${where}: el id «${id}» está repetido.`)
    seen.add(id)

    const at = anchor(entry['at'], `${where} («at»)`)
    if (typeof at === 'string') return fail(at)
    let when: Beat['when']
    if (entry['when'] !== undefined) {
      const found = anchor(entry['when'], `${where} («when»)`)
      if (typeof found === 'string') return fail(found)
      const visit = (entry['when'] as Record<string, unknown>)['visit']
      if (visit !== undefined && (!Number.isInteger(visit) || (visit as number) < 1)) {
        return fail(`${where}: «visit» es un entero desde 1.`)
      }
      when = { ...found, ...(visit === undefined ? {} : { visit: visit as number }) }
    }

    const note = entry['note']
    if (!isRecord(note)) return fail(`${where}: falta la nota.`)
    const body = text(note['text'], LESSON_LIMITS.text)
    if (!body || body.trim() === '') return fail(`${where}: la nota necesita un texto.`)
    const noteTitle = text(note['title'], LESSON_LIMITS.title)
    if (noteTitle === null) return fail(`${where}: el título de la nota no es válido.`)
    const style = note['style'] ?? 'sticky'
    if (!NOTE_STYLE_IDS.includes(style as NoteStyleId)) {
      return fail(
        `${where}: la clase de nota «${String(style)}» no existe (${NOTE_STYLE_IDS.join(', ')}).`,
      )
    }
    let ask: Ask | undefined
    if (entry['ask'] !== undefined) {
      const question = entry['ask']
      if (!isRecord(question)) return fail(`${where}: «ask» debe ser un objeto.`)
      const prompt = text(question['text'], LESSON_LIMITS.title)
      if (!prompt || prompt.trim() === '') return fail(`${where}: la pregunta necesita un texto.`)
      const expect = question['expect']
      if (expect !== 'value' && expect !== 'output') {
        return fail(`${where}: «expect» es «value» o «output».`)
      }
      const name = text(question['name'], LESSON_LIMITS.meta)
      if (name === null) return fail(`${where}: el nombre de la pregunta no es válido.`)
      if (expect === 'value' && !name)
        return fail(`${where}: preguntar por un valor necesita «name».`)
      ask = { text: prompt, expect, ...(name ? { name } : {}) }
    }
    beats.push({
      id,
      at,
      ...(when ? { when } : {}),
      ...(ask ? { ask } : {}),
      note: {
        text: body,
        style: style as NoteStyleId,
        ...(noteTitle ? { title: noteTitle } : {}),
      },
    })
  }

  return {
    ok: true,
    lesson: {
      version: 1,
      title,
      ...(level ? { level } : {}),
      ...(lang ? { lang } : {}),
      ...(source ? { source } : {}),
      ...(show ? { show } : {}),
      beats,
    },
  }
}

/** Lee el texto de un guion: JSON, con un tope de tamaño y un motivo legible si no lo es. */
export function readLesson(raw: string): LessonResult {
  if (raw.length > LESSON_LIMITS.file) return fail('El guion es demasiado grande.')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    return fail(
      `El guion no es JSON válido: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return parseLesson(value)
}

/** Dónde vive el guion de un programa: `factorial.py` → `factorial.lesson.json`, en la misma carpeta. */
export const lessonFileFor = (pyFile: string): string =>
  pyFile.replace(/\.pyw?$/i, '') + '.lesson.json'

/**
 * Un guion de partida para un programa: un momento por cada una de sus primeras sentencias, con la nota por
 * escribir. Es lo que se crea al pedir «Crear la lección de este archivo».
 */
export function skeletonLesson(name: string, statements: readonly string[]): string {
  const beats = statements.slice(0, 4).map((statement, index) => ({
    id: `b${index + 1}`,
    at: { text: statement },
    note: { text: 'Explica aquí qué pasa en esta línea.', style: 'sticky' },
  }))
  return (
    JSON.stringify(
      { version: 1, title: name.replace(/\.pyw?$/i, ''), lang: 'es', source: name, beats },
      null,
      2,
    ) + '\n'
  )
}
