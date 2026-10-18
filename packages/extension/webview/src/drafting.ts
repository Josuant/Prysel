/**
 * Lo que ya se sabe de una pieza mientras se está pidiendo, sacado de lo que se lleva dicho: cómo se llama,
 * qué recibe y qué hace. Con ello se rellena su caja palabra a palabra, antes de que exista el código.
 *
 * No decide nada (qué clase de pieza es lo dice el JEV): solo lee lo que la frase ya dice. Si algo no se ha
 * dicho todavía, no se inventa: la caja lo enseña vacío.
 */

/** El esbozo de lo que se está pidiendo: qué es, y las partes que la frase ya nombra. */
export interface Sketch {
  what: string
  parts: string[]
}

/** Lo que abre una petición sin decir todavía qué se pide: «quiero», «hazme», «necesito que»… */
const OPENING =
  /^(?:(?:por favor|oye|vale|bueno|a ver),?\s+)?(?:quiero|quisiera|necesito|me gustar[ií]a|hazme|haz|crea|cr[eé]ame|constr[uú]yeme|construye|escribe|prog?rama|dame|genera)\s+(?:que\s+)?/i

/**
 * Lo que la frase ya deja ver de lo que se pide, mientras se escribe: la cosa («una lista de tareas») y sus
 * partes, tal como se van nombrando («añadir», «marcar como hechas», «ver las pendientes»). No decide nada ni
 * inventa: solo trocea lo que hay escrito por donde la propia frase se separa (comas, «y», «donde», «con»).
 * Una parte a medio escribir (la última, si aún no se ha puesto el espacio) también cuenta: se ve crecer.
 */
export function sketchOf(text: string): Sketch | null {
  const clean = text.replace(/\s+/g, ' ').replace(OPENING, '').trim()
  // Solo la palabra con la que se empieza a pedir («haz», «quiero»): aún no se ha dicho qué.
  if (clean.length < 3 || OPENING.test(`${clean} `)) return null
  const [head = '', ...rest] = clean.split(
    /\s+(?:donde|en (?:el|la) que|en (?:el|la) cual|que (?:pueda|tenga|me deje|me permita|sirva para)|para(?: poder)?|con)\s+/i,
  )
  const pieces = rest
    .join(', ')
    .split(/\s*(?:,|;|\by\b|\be\b|\bo\b)\s*/i)
    .map((part) => part.replace(/^(?:pueda|poder|que|tambi[eé]n|luego|adem[aá]s)\s+/i, '').trim())
    .filter((part) => part.length >= 3)
  const what = head.replace(/[.,;:]+$/, '').trim()
  if (what === '') return null
  return { what, parts: pieces.slice(0, 6).map((part) => part.replace(/[.,;:]+$/, '')) }
}

/** Palabras que no dicen de qué va una parte: no sirven para reconocerla en el programa. */
const FILLER = new Set(
  'el la los las un una unos unas de del al que como por para con sin mi mis su sus lo le se me en cada todo toda todos todas'.split(
    ' ',
  ),
)

/** Las palabras con peso de un texto, sin tildes ni mayúsculas («marcar_como_hecha» → marcar, hecha). */
const wordsOf = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !FILLER.has(word))

/** Dos palabras de la misma familia: empiezan igual («hechas» y «hecha», «añadir» y «añade»). */
const akin = (a: string, b: string) => {
  const size = Math.min(4, a.length, b.length)
  return a.slice(0, size) === b.slice(0, size)
}

/**
 * Qué pieza del programa cubre cada parte del esbozo, si ya hay alguna: la que más palabras comparte con
 * ella. `pieces` son los nombres de lo construido (etapas, funciones, clases), en el orden en que aparecen.
 * No inventa: una parte que ninguna pieza nombra se queda como hueco (`null`).
 */
export function filledBy(sketch: Sketch, pieces: readonly string[]): (string | null)[] {
  const known = pieces.map((piece) => ({ piece, words: wordsOf(piece) }))
  return sketch.parts.map((part) => {
    const wanted = wordsOf(part)
    let best: string | null = null
    let most = 0
    for (const { piece, words } of known) {
      const shared = wanted.filter((word) => words.some((other) => akin(word, other))).length
      if (shared > most) {
        most = shared
        best = piece
      }
    }
    return best
  })
}

/**
 * Lo que dijo el JEV de cada parte (`judged`: la pieza, `''` si ninguna, `null` si no lo sabe), sobre lo que
 * dicen las palabras (`worded`). Manda el JEV cuando opina; una pieza que ya no existe no cuenta.
 */
export function coverOf(
  worded: readonly (string | null)[],
  judged: readonly (string | null)[] | null,
  pieces: readonly string[],
): (string | null)[] {
  return worded.map((word, at) => {
    const said = judged?.[at] ?? null
    if (said === null) return word
    if (said === '') return null
    return pieces.includes(said) ? said : word
  })
}

/** Los nombres de lo que un programa ya tiene: sus etapas y sus funciones y clases. */
export function piecesOf(source: string, stages: readonly string[]): string[] {
  const named = [...source.matchAll(/^[ \t]*(?:async\s+)?(?:def|class)\s+([^\s(:]+)/gm)].map(
    (match) => match[1] ?? '',
  )
  return [...named, ...stages].filter((name) => name !== '' && !name.startsWith('__'))
}

export interface Draft {
  name?: string
  takes?: string[]
  does?: string
}

/** Palabras que siguen a «una función…» sin ser su nombre. */
const NOT_A_NAME = new Set(
  'que para de del con y o un una unos unas el la los las nueva nuevo llamada llamado se me nos donde cuando como al en por sin sobre'.split(
    ' ',
  ),
)

const NOUN: Record<string, RegExp> = {
  funcion: /\b(?:funci[oó]n|m[eé]todo)\b/i,
  clase: /\bclase\b/i,
  bucle: /\bbucle\b/i,
  decision: /\b(?:decisi[oó]n|condici[oó]n)\b/i,
  variable: /\b(?:variable|constante|dato)\b/i,
  lista: /\b(?:lista|diccionario|colecci[oó]n)\b/i,
  programa: /\b(?:programa|algoritmo|juego|simulaci[oó]n)\b/i,
}

const COUNT: Record<string, number> = { un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 }

/** El nombre de lo que se recibe, en singular y corto: «números» → «número». */
const singular = (noun: string) => noun.replace(/(?:es|s)$/i, '')

/**
 * Lo que la frase ya dice de la pieza. `kind` es la clase de pieza que dijo el JEV (`funcion`, `clase`…).
 */
export function draftOf(kind: string, heard: string): Draft {
  const text = heard.trim().replace(/\s+/g, ' ')
  const noun = NOUN[kind]
  const found = noun?.exec(text)
  // Lo que viene detrás de «función», «clase»…
  const after = found ? text.slice(found.index + found[0].length).trim() : ''
  const draft: Draft = {}

  // El nombre: lo que va justo detrás de «función», «clase»… si es un nombre y no el principio de una frase.
  const named =
    /^(?:llamad[ao]\s+|que\s+se\s+llame\s+|de\s+nombre\s+)?([\p{L}_][\p{L}\p{N}_]*)/u.exec(
      after,
    )?.[1]
  const explicit = /^(?:llamad[ao]|que\s+se\s+llame|de\s+nombre)\s/i.test(after)
  if (named && (explicit || !NOT_A_NAME.has(named.toLowerCase()))) {
    draft.name = kind === 'clase' ? named.charAt(0).toUpperCase() + named.slice(1) : named
  }

  // Lo que recibe: «dos números», «un texto», o «que reciba a y b».
  const takes: string[] = []
  const counted =
    /\b(un|una|dos|tres|cuatro|cinco)\s+(n[uú]meros?|textos?|listas?|valores?|datos?|palabras?|nombres?)\b/iu.exec(
      text,
    )
  if (counted) {
    const count = COUNT[(counted[1] ?? '').toLowerCase()] ?? 1
    const what = singular(counted[2] ?? '')
    for (let i = 1; i <= count; i++) takes.push(count === 1 ? what : `${what} ${i}`)
  }
  const given = /\bque\s+recib[ae]n?\s+(.+?)(?:\s+y\s+(?:devuelva|haga|calcule|que)\b|$)/iu.exec(
    text,
  )?.[1]
  if (given && takes.length === 0) {
    for (const part of given.split(/\s*,\s*|\s+y\s+/)) {
      const word = /([\p{L}_][\p{L}\p{N}_]*)$/u.exec(part.trim())?.[1]
      if (word && !NOT_A_NAME.has(word.toLowerCase())) takes.push(word)
    }
  }
  if (takes.length > 0) draft.takes = takes.slice(0, 5)

  // Lo que hace: lo que viene tras el «que» (o todo lo dicho, si aún no hay más).
  const does = /\bque\s+(.+)$/iu.exec(after)?.[1] ?? (draft.name ? '' : after)
  draft.does = (does || text).slice(0, 140)
  return draft
}
