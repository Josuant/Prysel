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
export const INSIGHT_IDS = [
  'variables',
  'stack',
  'tree',
  'memory',
  'collection',
  'evolution',
  'trail',
  'structure',
  'cost',
  'concept',
] as const
export type InsightIdentifier = (typeof INSIGHT_IDS)[number]

/** Una serie de la tarjeta «Evolución»: el nombre de una variable numérica y cómo se llama en la leyenda. */
export interface TrackedSeries {
  label: string
  name: string
}

/**
 * Lo que dibuja la tarjeta «Trayectoria»: el camino de un valor numérico a lo largo del tiempo (una altura,
 * una posición…) dentro de unos límites conocidos, y de un obstáculo opcional con el que se compara (su
 * posición y el centro del hueco por el que se pasa).
 */
export interface Trail {
  value: string
  min: number
  max: number
  obstacle?: { name: string; gap: string; width: number }
}

/**
 * Lo que mide la tarjeta «Coste»: cuántos pasos da cada llamada a una función frente al tamaño de lo que
 * recibe (`n`: el nombre del parámetro que da el tamaño; sin él, el primero). La complejidad, vista.
 */
export interface Cost {
  fn: string
  n?: string
}

/**
 * Una idea sin código (tarjeta «Concepto»): qué es, a qué se parece y el error típico. Va con un momento
 * del guion; antes de empezar se enseña la primera, para poder empezar por la idea.
 */
export interface Concept {
  term: string
  definition: string
  analogy?: string
  mistake?: string
}

/**
 * Un ejercicio sobre el propio programa: qué conseguir y la comprobación (un `assert`, o varios) que dice
 * si ya se consiguió. Se comprueba ejecutando el programa de verdad, tal como esté en ese momento.
 */
export interface Exercise {
  goal: string
  check: string
  hint?: string
  /** Lo que se dice al conseguirlo (si no, un «¡Bien!»). */
  success?: string
}

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
  /** La idea que se cuenta en este momento (tarjeta «Concepto»). */
  concept?: Concept
  note: {
    text: string
    style: NoteStyleId
    title?: string
    /**
     * Dónde la dejó quien la arrastró a mano: cuánto se aparta (en píxeles del lienzo) del sitio en que la
     * pondría el margen. Relativo a ese sitio, así sigue cerca de lo que explica si el diagrama cambia.
     */
    offset?: { x: number; y: number }
  }
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
  /** Las series que sigue la tarjeta «Evolución», si se pide en `show`. */
  track?: TrackedSeries[]
  /** Lo que dibuja la tarjeta «Trayectoria», si se pide en `show`. */
  trail?: Trail
  /** Lo que mide la tarjeta «Coste», si se pide en `show`. */
  cost?: Cost
  /** Un ejercicio sobre el programa, con su comprobación. */
  exercise?: Exercise
  beats: Beat[]
}

export const LESSON_LIMITS = {
  beats: 200,
  title: 200,
  text: 2000,
  anchor: 300,
  meta: 60,
  /** Cuánto se puede apartar una nota, a mano, del sitio que le da el margen (en cada eje). */
  offset: 5000,
  /** El guion entero, en caracteres: por encima, se descarta antes de mirarlo. */
  file: 512_000,
}

/**
 * El guion con una nota puesta a mano en otro sitio (o devuelta al suyo, con `offset` nulo). Toca **solo** la
 * posición de esa nota, sobre el texto tal como está en el archivo: el guion lo escribe una persona, y mover
 * una nota no puede reescribirle el formato (ni perder nada que esta versión no conozca). `null` si el texto no
 * es un guion con ese momento.
 */
export function moveNoteIn(
  raw: string,
  beatId: string,
  offset: { x: number; y: number } | null,
): string | null {
  // Primero, que sea un guion de verdad; después se busca dónde está cada trozo en el texto.
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value) || !Array.isArray(value['beats'])) return null
  const root = locate(raw)
  const beats = root?.kind === 'object' ? entryOf(root, 'beats') : undefined
  if (beats?.kind !== 'array') return null
  const beat = beats.items.find((item) => {
    const id = item.kind === 'object' ? entryOf(item, 'id') : undefined
    return id?.kind === 'scalar' && id.value === beatId
  })
  const note = beat?.kind === 'object' ? entryOf(beat, 'note') : undefined
  if (note?.kind !== 'object') return null

  const index = note.entries.findIndex((entry) => entry.key === 'offset')
  const current = note.entries[index]
  if (offset === null) {
    if (!current) return raw
    // Con la coma que la separa: la de antes si la hay; si es la primera, la de después.
    const previous = note.entries[index - 1]
    const next = note.entries[index + 1]
    const [from, to] = previous
      ? [previous.value.end, current.value.end]
      : next
        ? [current.at, next.at]
        : [note.start + 1, note.end - 1]
    return raw.slice(0, from) + raw.slice(to)
  }
  const text = `{ "x": ${Math.round(offset.x)}, "y": ${Math.round(offset.y)} }`
  if (current) return raw.slice(0, current.value.start) + text + raw.slice(current.value.end)
  const last = note.entries[note.entries.length - 1]
  if (!last) return `${raw.slice(0, note.start + 1)}"offset": ${text}${raw.slice(note.end - 1)}`
  // Como las demás propiedades de la nota: en su línea y con su sangría si van una por línea; si no, detrás.
  const lineStart = raw.lastIndexOf('\n', last.at - 1) + 1
  const indent = raw.slice(lineStart, last.at)
  const ownLine = /^[ \t]*$/.test(indent) && raw.slice(note.start, last.at).includes('\n')
  const glue = ownLine ? `,${raw.includes('\r\n') ? '\r\n' : '\n'}${indent}` : ', '
  return `${raw.slice(0, last.value.end)}${glue}"offset": ${text}${raw.slice(last.value.end)}`
}

/** Un valor de un JSON con su sitio en el texto: lo que hace falta para tocar un trozo y dejar el resto igual. */
type Located =
  | {
      kind: 'object'
      start: number
      end: number
      /** Cada propiedad: su nombre, dónde empieza (su comilla) y su valor. */
      entries: { key: string; at: number; value: Located }[]
    }
  | { kind: 'array'; start: number; end: number; items: Located[] }
  | { kind: 'scalar'; start: number; end: number; value: unknown }

const entryOf = (object: Extract<Located, { kind: 'object' }>, key: string) =>
  object.entries.find((entry) => entry.key === key)?.value

const SCALAR = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y

/** Recorre un JSON (ya sabido válido) y devuelve cada valor con dónde empieza y acaba en el texto. */
function locate(raw: string): Located | null {
  let i = 0
  const space = () => {
    while (i < raw.length && ' \t\r\n'.includes(raw[i] ?? '')) i++
  }
  const string = (): string => {
    const start = i
    i++
    while (i < raw.length && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1
    i++
    return JSON.parse(raw.slice(start, i)) as string
  }
  const value = (): Located => {
    space()
    const start = i
    if (raw[i] === '{') {
      i++
      const entries: { key: string; at: number; value: Located }[] = []
      space()
      while (raw[i] !== '}') {
        space()
        const at = i
        const key = string()
        space()
        i++ // los dos puntos
        entries.push({ key, at, value: value() })
        space()
        if (raw[i] === ',') i++
      }
      i++
      return { kind: 'object', start, end: i, entries }
    }
    if (raw[i] === '[') {
      i++
      const items: Located[] = []
      space()
      while (raw[i] !== ']') {
        items.push(value())
        space()
        if (raw[i] === ',') i++
        space()
      }
      i++
      return { kind: 'array', start, end: i, items }
    }
    if (raw[i] === '"') {
      const text = string()
      return { kind: 'scalar', start, end: i, value: text }
    }
    SCALAR.lastIndex = i
    const match = SCALAR.exec(raw)
    if (!match) throw new Error(`JSON inesperado en ${i}`)
    i += match[0].length
    return { kind: 'scalar', start, end: i, value: JSON.parse(match[0]) as unknown }
  }
  try {
    return value()
  } catch {
    return null
  }
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
  let track: TrackedSeries[] | undefined
  if (value['track'] !== undefined) {
    const listed = value['track']
    if (!Array.isArray(listed) || listed.length === 0 || listed.length > 6) {
      return fail('«track» es una lista de 1 a 6 series: { label, name }.')
    }
    const parsed: TrackedSeries[] = []
    for (const entry of listed) {
      if (!isRecord(entry)) return fail('«track»: cada serie es un objeto { label, name }.')
      const label = text(entry['label'], LESSON_LIMITS.meta)
      const name = text(entry['name'], LESSON_LIMITS.meta)
      if (!label || !name) return fail('«track»: «label» y «name» son obligatorios.')
      parsed.push({ label, name })
    }
    track = parsed
  }
  let trail: Trail | undefined
  if (value['trail'] !== undefined) {
    const spec = value['trail']
    if (!isRecord(spec)) return fail('«trail» debe ser un objeto.')
    const trailValue = text(spec['value'], LESSON_LIMITS.meta)
    const min = spec['min']
    const max = spec['max']
    if (!trailValue) return fail('«trail.value» es obligatorio.')
    if (typeof min !== 'number' || typeof max !== 'number' || min >= max) {
      return fail('«trail.min»/«trail.max» son números, con min < max.')
    }
    let obstacle: Trail['obstacle']
    if (spec['obstacle'] !== undefined) {
      const raw = spec['obstacle']
      if (!isRecord(raw)) return fail('«trail.obstacle» debe ser un objeto.')
      const name = text(raw['name'], LESSON_LIMITS.meta)
      const gap = text(raw['gap'], LESSON_LIMITS.meta)
      const width = raw['width']
      if (!name || !gap || typeof width !== 'number' || width <= 0) {
        return fail('«trail.obstacle» necesita «name», «gap» y «width» (número positivo).')
      }
      obstacle = { name, gap, width }
    }
    trail = { value: trailValue, min, max, ...(obstacle ? { obstacle } : {}) }
  }
  let cost: Cost | undefined
  if (value['cost'] !== undefined) {
    const spec = value['cost']
    if (!isRecord(spec)) return fail('«cost» debe ser un objeto.')
    const fn = text(spec['fn'], LESSON_LIMITS.meta)
    const n = text(spec['n'], LESSON_LIMITS.meta)
    if (!fn) return fail('«cost.fn» es obligatorio: la función cuyo coste se mide.')
    if (n === null) return fail('«cost.n» no es válido.')
    cost = { fn, ...(n ? { n } : {}) }
  }
  let exercise: Exercise | undefined
  if (value['exercise'] !== undefined) {
    const spec = value['exercise']
    if (!isRecord(spec)) return fail('«exercise» debe ser un objeto.')
    const goal = text(spec['goal'], LESSON_LIMITS.text)
    const check = text(spec['check'], LESSON_LIMITS.text)
    const hint = text(spec['hint'], LESSON_LIMITS.text)
    const success = text(spec['success'], LESSON_LIMITS.text)
    if (!goal || goal.trim() === '')
      return fail('«exercise.goal» es obligatorio: qué hay que conseguir.')
    if (!check || check.trim() === '') {
      return fail(
        '«exercise.check» es obligatorio: la comprobación (un assert) que dice si ya está.',
      )
    }
    if (hint === null || success === null) return fail('«exercise.hint»/«success» no son válidos.')
    exercise = { goal, check, ...(hint ? { hint } : {}), ...(success ? { success } : {}) }
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
    let offset: { x: number; y: number } | undefined
    if (note['offset'] !== undefined) {
      const moved = note['offset']
      const coordinate = (n: unknown) =>
        typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= LESSON_LIMITS.offset
      if (!isRecord(moved) || !coordinate(moved['x']) || !coordinate(moved['y'])) {
        return fail(
          `${where}: «offset» es { "x": número, "y": número } (como mucho ${LESSON_LIMITS.offset} de cada lado).`,
        )
      }
      offset = { x: Math.round(moved['x'] as number), y: Math.round(moved['y'] as number) }
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
    let concept: Concept | undefined
    if (entry['concept'] !== undefined) {
      const idea = entry['concept']
      if (!isRecord(idea)) return fail(`${where}: «concept» debe ser un objeto.`)
      const term = text(idea['term'], LESSON_LIMITS.title)
      const definition = text(idea['definition'], LESSON_LIMITS.text)
      const analogy = text(idea['analogy'], LESSON_LIMITS.text)
      const mistake = text(idea['mistake'], LESSON_LIMITS.text)
      if (!term || !definition) return fail(`${where}: un concepto necesita «term» y «definition».`)
      if (analogy === null || mistake === null) {
        return fail(`${where}: «analogy»/«mistake» del concepto no son válidos.`)
      }
      concept = {
        term,
        definition,
        ...(analogy ? { analogy } : {}),
        ...(mistake ? { mistake } : {}),
      }
    }
    beats.push({
      id,
      at,
      ...(when ? { when } : {}),
      ...(ask ? { ask } : {}),
      ...(concept ? { concept } : {}),
      note: {
        text: body,
        style: style as NoteStyleId,
        ...(noteTitle ? { title: noteTitle } : {}),
        ...(offset ? { offset } : {}),
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
      ...(track ? { track } : {}),
      ...(trail ? { trail } : {}),
      ...(cost ? { cost } : {}),
      ...(exercise ? { exercise } : {}),
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
