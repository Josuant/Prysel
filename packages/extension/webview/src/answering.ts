/**
 * Lo que se dice no siempre es una orden nueva. Con el micrófono abierto hay dos cosas que se contestan de
 * palabra y que no deben ir al motor como si fueran peticiones:
 *
 * - **la respuesta a una pregunta** que el editor acaba de hacer («sí», «la segunda», «no, déjalo»);
 * - **«no, eso no»**: lo último que se hizo no era lo que se quería. Se deshace, y si detrás viene la
 *   corrección («no, eso no, que reste»), eso es lo que se pide ahora.
 *
 * Aquí solo se reconoce lo que se ha dicho. Es puro: quien lo usa decide qué hacer.
 */

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:«»"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const YES =
  /^(si|vale|ok|okay|claro|adelante|hazlo|venga|correcto|exacto|eso|eso es|si por favor|dale)$/
const NO = /^(no|no gracias|cancela|cancelar|dejalo|nada|ninguna|ninguno|olvidalo|para)$/
const ORDINAL: Record<string, number> = {
  primera: 0,
  primero: 0,
  uno: 0,
  una: 0,
  segunda: 1,
  segundo: 1,
  dos: 1,
  tercera: 2,
  tercero: 2,
  tres: 2,
  cuarta: 3,
  cuarto: 3,
  cuatro: 3,
  ultima: -1,
  ultimo: -1,
}

/**
 * A cuál de las opciones de una pregunta contesta lo dicho: su posición, `'no'` si la rechaza, o `null` si
 * no es una respuesta (y entonces es otra cosa: una orden nueva).
 */
export function answerTo(said: string, labels: readonly string[]): number | 'no' | null {
  const text = fold(said)
  if (text === '' || labels.length === 0) return null
  if (NO.test(text)) return 'no'
  if (YES.test(text)) return 0
  // «la segunda», «la última», «opción dos».
  const words = text.split(' ')
  if (words.length <= 3) {
    for (const word of words) {
      const at = ORDINAL[word]
      if (at !== undefined) {
        const index = at === -1 ? labels.length - 1 : at
        if (index < labels.length) return index
      }
    }
  }
  // O dice la opción (o lo esencial de ella).
  const named = labels.findIndex((label) => {
    const option = fold(label)
    return option !== '' && (text.includes(option) || (text.length >= 4 && option.includes(text)))
  })
  return named >= 0 ? named : null
}

const REJECT =
  /^(?:no\s+)?(?:eso no|asi no|no era eso|no es eso|no queria eso|esta mal|deshazlo|deshaz eso|deshaz|deshacer|quita eso|quitalo|vuelve atras|marcha atras)\b\s*(.*)$/

/**
 * Si lo dicho rechaza lo último que se hizo. `then` es lo que viene detrás (la corrección), tal como se
 * dijo, o `''` si solo lo rechaza. `null`: no es un rechazo.
 */
export function rejection(said: string): { then: string } | null {
  const match = REJECT.exec(fold(said))
  if (!match) return null
  const rest = (match[1] ?? '').trim()
  // Lo que queda, con las palabras originales (sus acentos): las últimas tantas como tenga el resto.
  const count = rest === '' ? 0 : rest.split(' ').length
  const original = said.trim().replace(/\s+/g, ' ').split(' ')
  return { then: count === 0 ? '' : original.slice(-count).join(' ') }
}
