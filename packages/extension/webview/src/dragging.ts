import { findIn } from './marking.ts'

/**
 * Enseñar que una pieza **usa algo que ya estaba definido**: se coge su chip de donde está y se arrastra hasta
 * la casilla donde se usa, como lo haría una persona con el ratón. No mueve nada de verdad —el código ya está
 * escrito—: es una copia del chip la que viaja, con el puntero que la lleva.
 */

/** Cuánto dura el gesto entero: cogerlo, llevarlo y soltarlo. */
export const DRAG_MS = 1300
/** Lo que se espera entre un chip y el siguiente, cuando la pieza usa varios. */
export const DRAG_GAP_MS = 450

const POINTER =
  '<svg class="chip-ghost__hand" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<path d="M3 1.5 L3 12.5 L6 9.8 L8.2 14.5 L10 13.7 L7.9 9.2 L12 9 Z"/></svg>'

/** Dónde lleva un nodo su propio nombre: el de su chip, o su título. */
const NAME = '.vchip__name, .node__title, .node__rename'

/** El nombre con el que un nodo ofrece su valor. */
const namesOf = (source: Element) =>
  [...source.querySelectorAll<HTMLElement>(NAME)].filter((element) =>
    /^[A-Za-z_]\w*$/.test(textOf(element)),
  )

const textOf = (element: HTMLElement) =>
  (element instanceof HTMLInputElement ? element.value : (element.textContent ?? '')).trim()

/** Un color que se ve: `null` si es transparente. */
const solid = (color: string) => (color === 'transparent' || /,\s*0\)$/.test(color) ? null : color)

/**
 * Arrastra, uno detrás de otro, el chip de cada origen hasta donde la pieza lo usa. Los orígenes que la pieza
 * no nombra (o que no se ven) se saltan. Devuelve cómo cortar lo que quede.
 */
export function dragChips(target: Element, sources: readonly Element[]): () => void {
  const stage = target.closest<HTMLElement>('.react-flow')
  if (!stage) return () => undefined
  const undo: (() => void)[] = []
  let turn = 0
  for (const source of sources) {
    // De los nombres del origen, el que la pieza tiene escrito.
    const hit = namesOf(source)
      // Donde se usa, no donde la pieza se nombra a sí misma: en `x = x.lower()` va a la `x` de la derecha.
      .map((name) => ({
        name,
        at: findIn(target, [textOf(name)], (field) => field.matches(NAME)),
      }))
      .find((entry) => entry.at !== null)
    if (!hit?.at) continue
    const { name, at } = hit
    const timer = setTimeout(
      () => {
        undo.push(drag(stage, name, at.field, at.part))
      },
      turn++ * (DRAG_GAP_MS + DRAG_MS * 0.4),
    )
    undo.push(() => {
      clearTimeout(timer)
    })
  }
  return () => {
    for (const stop of undo) stop()
  }
}

function drag(
  stage: HTMLElement,
  name: HTMLElement,
  field: HTMLElement,
  part: { x: number; w: number } | null,
): () => void {
  const frame = stage.getBoundingClientRect()
  const from = name.getBoundingClientRect()
  const to = field.getBoundingClientRect()
  // El lienzo tiene su zoom: lo que mide un campo por dentro no es lo que ocupa en pantalla.
  const zoom = field.offsetWidth > 0 ? to.width / field.offsetWidth : 1
  const holder = name.closest<HTMLElement>('.vchip') ?? name
  const look = getComputedStyle(holder)
  const type = getComputedStyle(name)

  const ghost = document.createElement('div')
  ghost.className = 'chip-ghost'
  ghost.textContent = textOf(name)
  ghost.insertAdjacentHTML('beforeend', POINTER)
  ghost.style.font = type.font
  ghost.style.fontSize = `${(parseFloat(type.fontSize) * zoom).toFixed(1)}px`
  const paint = solid(look.backgroundColor)
  if (paint) ghost.style.background = paint
  ghost.style.color = look.color
  stage.append(ghost)

  // De dónde sale (sin salirse del lienzo: si el origen no se ve, entra por el borde que le toca) y adónde va.
  const clamp = (value: number, max: number) => Math.max(8, Math.min(value, max - 8))
  const size = ghost.getBoundingClientRect()
  const startX = clamp(from.left + from.width / 2 - frame.left, frame.width) - size.width / 2
  const startY = clamp(from.top + from.height / 2 - frame.top, frame.height) - size.height / 2
  const landing = part ? to.left + (part.x + part.w / 2) * zoom : to.left + to.width / 2
  const endX = landing - frame.left - size.width / 2
  const endY = to.top + to.height / 2 - frame.top - size.height / 2
  // Va haciendo un poco de arco, como una mano: no en línea recta.
  const midX = (startX + endX) / 2
  const midY = (startY + endY) / 2 - Math.min(40, Math.abs(endX - startX) * 0.15 + 12)
  const at = (x: number, y: number, extra: string) =>
    `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) ${extra}`

  holder.setAttribute('data-picked', '')
  const motion = ghost.animate(
    [
      { transform: at(startX, startY, 'scale(1)'), opacity: 0, offset: 0 },
      { transform: at(startX, startY, 'scale(1.14) rotate(-3deg)'), opacity: 1, offset: 0.14 },
      { transform: at(startX, startY - 3, 'scale(1.14) rotate(-3deg)'), opacity: 1, offset: 0.3 },
      { transform: at(midX, midY, 'scale(1.14) rotate(-2deg)'), opacity: 1, offset: 0.6 },
      { transform: at(endX, endY, 'scale(1.1) rotate(0deg)'), opacity: 1, offset: 0.86 },
      { transform: at(endX, endY, 'scale(0.96)'), opacity: 0, offset: 1 },
    ],
    { duration: DRAG_MS, easing: 'ease-in-out', fill: 'both' },
  )
  // Al soltarlo, la casilla que lo recibe lo acusa.
  const landed = setTimeout(() => {
    holder.removeAttribute('data-picked')
    field.setAttribute('data-dropped', '')
  }, DRAG_MS * 0.86)
  const done = setTimeout(() => {
    field.removeAttribute('data-dropped')
    ghost.remove()
  }, DRAG_MS + 500)
  return () => {
    clearTimeout(landed)
    clearTimeout(done)
    motion.cancel()
    ghost.remove()
    holder.removeAttribute('data-picked')
    field.removeAttribute('data-dropped')
  }
}
