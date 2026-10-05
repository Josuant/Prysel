/**
 * Subrayar, como con un rotulador en un cuaderno, la parte exacta de un nodo de la que habla la frase que se
 * está diciendo («se calcula el valor absoluto…» → `abs(sum(pesos) - 1.0)`). El trozo lo elige el JEV entre
 * los del código; aquí se busca dónde está escrito dentro del nodo.
 *
 * Un nodo no enseña su código tal cual: lo reparte en campos (un nombre, un operador, una expresión). Así que
 * se busca el campo más pequeño que contenga el trozo entero y, si ninguno lo contiene, el campo más largo
 * que sea parte de él.
 */

/** Igualar lo que se compara: sin espacios, sin distinguir mayúsculas, y con el menos tipográfico como guion. */
const norm = (text: string) => text.replace(/\s+/g, '').replace(/[−–]/g, '-').toLowerCase()

/**
 * De los textos de los campos de un nodo, cuál se subraya para un trozo de código. Devuelve su posición, o
 * -1 si ninguno casa.
 */
export function bestMatch(texts: readonly string[], fragment: string): number {
  const target = norm(fragment)
  if (target === '') return -1
  let holder = -1
  let part = -1
  texts.forEach((raw, index) => {
    const text = norm(raw)
    if (text === '') return
    if (text.includes(target)) {
      // El que lo contiene entero, cuanto más ajustado mejor.
      if (holder < 0 || text.length < norm(texts[holder] ?? '').length) holder = index
    } else if (target.includes(text) && text.length >= 2) {
      // O el trozo más largo de él que haya escrito.
      if (part < 0 || text.length > norm(texts[part] ?? '').length) part = index
    }
  })
  return holder >= 0 ? holder : part
}

/** Lo que tiene escrito un elemento: su valor, si es un campo; su texto, si no. */
const written = (element: Element) =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? element.value
    : (element.textContent ?? '')

/**
 * Subraya en un nodo del lienzo el campo que lleva ese trozo. Devuelve cómo quitar el subrayado (o `null` si
 * no encontró dónde).
 */
export function markIn(node: Element, fragment: string): (() => void) | null {
  const fields = [...node.querySelectorAll('input, textarea, code, span, p, div')].filter(
    (element) =>
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element.children.length === 0,
  )
  const found = fields[bestMatch(fields.map(written), fragment)]
  if (!found) return null
  found.setAttribute('data-marked', '')
  return () => {
    found.removeAttribute('data-marked')
  }
}
