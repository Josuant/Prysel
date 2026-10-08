/**
 * Lo que ya se sabe de una pieza mientras se está pidiendo, sacado de lo que se lleva dicho: cómo se llama,
 * qué recibe y qué hace. Con ello se rellena su caja palabra a palabra, antes de que exista el código.
 *
 * No decide nada (qué clase de pieza es lo dice el JEV): solo lee lo que la frase ya dice. Si algo no se ha
 * dicho todavía, no se inventa: la caja lo enseña vacío.
 */

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
