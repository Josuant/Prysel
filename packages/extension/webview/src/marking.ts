/**
 * Subrayar, como con un rotulador en un cuaderno, la parte exacta de un nodo de la que habla la frase que se
 * está diciendo («se calcula el valor absoluto…» → `abs(sum(pesos) - 1.0)`; «lo pasamos a minúsculas» →
 * `lower`). El trozo lo elige el JEV entre los del código; aquí se busca dónde está escrito dentro del nodo.
 *
 * Un nodo no enseña su código tal cual: lo reparte en campos (un nombre, un operador, una expresión). Así que
 * se busca el campo más pequeño que contenga el trozo entero —y dentro de él, el tramo justo— y, si ninguno
 * lo contiene, el campo más largo que sea parte de él.
 */

/** Igualar un carácter: sin distinguir mayúsculas, y con los signos tipográficos como los del código. */
const SIGNS: Record<string, string> = {
  '−': '-',
  '–': '-',
  '×': '*',
  '÷': '/',
  '≠': '!=',
  '≤': '<=',
  '≥': '>=',
}
const same = (char: string) => (SIGNS[char] ?? char).toLowerCase()

/** Igualar lo que se compara: además, sin espacios. */
const norm = (text: string) =>
  [...text]
    .filter((char) => !/\s/.test(char))
    .map(same)
    .join('')

const isWord = (char: string | undefined) => char !== undefined && /\w/.test(char)

/**
 * Dónde está escrito un trozo dentro de un texto: de qué carácter a cuál (el final, sin incluir). No cuentan
 * los espacios ni la tipografía. Un nombre o un número solo casa entero: `n` no está en `len`. `null` si no
 * está.
 */
export function locate(raw: string, fragment: string): { start: number; end: number } | null {
  const target = norm(fragment)
  if (target === '') return null
  // El texto igualado, y de qué carácter del original sale cada uno de los suyos.
  let text = ''
  const from: number[] = []
  const upto: number[] = []
  let at = 0
  for (const char of raw) {
    if (!/\s/.test(char))
      for (const piece of same(char)) {
        text += piece
        from.push(at)
        upto.push(at + char.length)
      }
    at += char.length
  }
  const whole = /^[\w.]+$/.test(target)
  for (let found = text.indexOf(target); found >= 0; found = text.indexOf(target, found + 1)) {
    const last = found + target.length - 1
    // Un nombre no casa a medias, dentro de otro; ni un número dentro de otro (`1` en `1.0`).
    const before = text[found - 1]
    const after = text[last + 1]
    const inNumber = /^[\d.]+$/.test(target) && (before === '.' || after === '.')
    const bounded = !whole || (!isWord(before) && !isWord(after) && !inNumber)
    if (bounded) return { start: from[found] ?? 0, end: upto[last] ?? raw.length }
  }
  return null
}

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
    if (locate(raw, fragment)) {
      // El que lo contiene entero, cuanto más ajustado mejor.
      if (holder < 0 || text.length < norm(texts[holder] ?? '').length) holder = index
    } else if (text.length >= 2 && locate(fragment, raw)) {
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

let ruler: CanvasRenderingContext2D | null | undefined

/**
 * Dónde cae, en píxeles del propio elemento, un tramo de su texto: desde dónde y cuánto mide. `null` si no
 * se puede saber con una regla (el texto está centrado, ocupa varias líneas, o no hay con qué medir): entonces
 * se subraya el campo entero.
 */
function stretch(element: HTMLElement, text: string, start: number, end: number) {
  const style = getComputedStyle(element)
  const field = element instanceof HTMLInputElement
  if (element instanceof HTMLTextAreaElement) return null
  if (!field && element.offsetHeight > parseFloat(style.fontSize) * 2.4) return null
  if (
    !['start', 'left'].includes(style.textAlign) &&
    (field || !style.display.startsWith('inline'))
  )
    return null
  ruler ??= document.createElement('canvas').getContext('2d')
  if (!ruler || style.font === '') return null
  ruler.font = style.font
  const spacing = parseFloat(style.letterSpacing) || 0
  const width = (piece: string) => (ruler?.measureText(piece).width ?? 0) + spacing * piece.length
  const left =
    (parseFloat(style.paddingLeft) || 0) +
    (field ? -element.scrollLeft : 0) +
    width(text.slice(0, start))
  return { x: left - 2, w: width(text.slice(start, end)) + 4 }
}

/** Los campos de un nodo: sus casillas y sus textos sueltos. */
const fieldsOf = (node: Element) =>
  [...node.querySelectorAll<HTMLElement>('input, textarea, code, span, p, div')].filter(
    (element) =>
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element.children.length === 0,
  )

/**
 * Dónde está escrito en un nodo un trozo de su código: el primero de los que se le dan (van por orden de
 * preferencia) que esté en él. Dice el campo que lo lleva y, si ese campo tiene más cosas, el tramo justo
 * (`part`, en píxeles del propio campo; sin él, es el campo entero). `null` si no está. Con `skip` se dejan
 * fuera los campos donde no hay que mirar.
 */
export function findIn(
  node: Element,
  fragments: readonly string[],
  skip?: (field: HTMLElement) => boolean,
): { field: HTMLElement; part: { x: number; w: number } | null } | null {
  const fields = skip ? fieldsOf(node).filter((field) => !skip(field)) : fieldsOf(node)
  const texts = fields.map(written)
  for (const fragment of fragments) {
    const index = bestMatch(texts, fragment)
    const field = fields[index]
    if (!field) continue
    const text = texts[index] ?? ''
    const span = locate(text, fragment)
    const part =
      span && norm(text.slice(span.start, span.end)) !== norm(text)
        ? stretch(field, text, span.start, span.end)
        : null
    return { field, part }
  }
  return null
}

/**
 * Subraya en un nodo del lienzo un trozo de su código: el primero de los que se le dan que esté escrito en
 * él. Si el campo que lo lleva tiene más cosas, se subraya solo su tramo. Devuelve cómo quitar el subrayado
 * (o `null` si no encontró dónde).
 */
export function markIn(node: Element, fragments: readonly string[]): (() => void) | null {
  const hit = findIn(node, fragments)
  if (!hit) return null
  const { field, part } = hit
  if (part) {
    field.style.setProperty('--mark-x', `${part.x.toFixed(1)}px`)
    field.style.setProperty('--mark-w', `${part.w.toFixed(1)}px`)
  }
  field.setAttribute('data-marked', part ? 'part' : '')
  return () => {
    field.removeAttribute('data-marked')
    field.style.removeProperty('--mark-x')
    field.style.removeProperty('--mark-w')
  }
}
