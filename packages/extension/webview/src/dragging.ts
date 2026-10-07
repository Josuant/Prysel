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
/**
 * Enseñar que algo **cambia de sitio**: su nombre se coge de donde está y viaja hasta el destino —dentro de
 * él, o justo antes o después—, que lo espera señalado. El código cambia al llegar. Devuelve cuánto dura (0
 * si no se pudo enseñar) y cómo cortarlo.
 */
export function flyNode(
  source: Element,
  target: Element,
  how: 'into' | 'after' | 'before',
): { ms: number; stop: () => void } {
  const stage = target.closest<HTMLElement>('.react-flow')
  const name =
    namesOf(source)[0] ??
    source.querySelector<HTMLElement>('.node, .vchip') ??
    (source as HTMLElement)
  if (!stage || !(target instanceof HTMLElement)) return { ms: 0, stop: () => undefined }
  const box = target.querySelector<HTMLElement>('.node, .vchip') ?? target
  box.setAttribute('data-receiving', how)
  // Lo que se copia no se va de su sitio.
  if (source !== target) source.setAttribute('data-moving', '')
  const stop = drag(
    stage,
    name,
    box,
    null,
    how === 'into' ? 'center' : how === 'after' ? 'below' : 'above',
  )
  const done = setTimeout(() => {
    box.removeAttribute('data-receiving')
    source.removeAttribute('data-moving')
  }, DRAG_MS + 200)
  return {
    ms: DRAG_MS,
    stop: () => {
      clearTimeout(done)
      stop()
      box.removeAttribute('data-receiving')
      source.removeAttribute('data-moving')
    },
  }
}

/** Lo que dura un gesto que no viaja: lo que se enmarca, lo que se levanta. */
export const GESTURE_MS = 950

/**
 * Enseñar lo que se le va a hacer a una pieza antes de que cambie el código:
 * - `wrap`: algo nuevo la va a contener: un marco se abre a su alrededor;
 * - `extract`: se va a sacar a una función propia: se levanta de donde está;
 * - `copy`: se va a duplicar: su nombre se desdobla y cae justo debajo;
 * - `merge`: se va a juntar con otra: viaja hasta ella.
 * Devuelve cuánto dura (0 si no se pudo enseñar).
 */
export function gesture(
  kind: 'wrap' | 'copy' | 'merge' | 'extract',
  source: Element,
  other?: Element | null,
): number {
  if (kind === 'copy') return flyNode(source, source, 'after').ms
  if (kind === 'merge') return other ? fuse(source, other) : 0
  const box = source.querySelector<HTMLElement>('.node, .vchip') ?? (source as HTMLElement)
  box.setAttribute('data-gesture', kind)
  setTimeout(() => {
    box.removeAttribute('data-gesture')
  }, GESTURE_MS + 150)
  return GESTURE_MS
}

/** Lo que tarda cada pieza en llegar al punto de encuentro, y lo que dura la que queda. */
const FUSE_MS = 900
const FUSED_MS = 2200

/**
 * Dos piezas se juntan en una: el nombre de cada una sale de donde está y van a encontrarse a medio camino;
 * al tocarse, queda una sola —con los dos nombres—, latiendo, mientras se escribe la que las reúne. Las
 * originales se quedan en sombra. Devuelve cuánto dura el encuentro.
 */
function fuse(first: Element, second: Element): number {
  const stage = first.closest<HTMLElement>('.react-flow')
  if (!stage) return 0
  const frame = stage.getBoundingClientRect()
  const pieces = [first, second].map((piece) => {
    const name =
      namesOf(piece)[0] ??
      piece.querySelector<HTMLElement>('.node, .vchip') ??
      (piece as HTMLElement)
    const box = name.getBoundingClientRect()
    return {
      piece,
      name,
      text: textOf(name).slice(0, 28),
      x: box.left + box.width / 2 - frame.left,
      y: box.top + box.height / 2 - frame.top,
    }
  })
  const [a, b] = pieces
  if (!a || !b) return 0
  // Se encuentran entre las dos, un poco más abajo: donde va a nacer la que las reúne.
  const meetX = Math.max(60, Math.min((a.x + b.x) / 2, frame.width - 60))
  const meetY = Math.max(40, Math.min((a.y + b.y) / 2 + 54, frame.height - 40))
  const ghosts = pieces.map((item) => {
    const holder = item.name.closest<HTMLElement>('.vchip') ?? item.name
    const look = getComputedStyle(holder)
    const ghost = document.createElement('div')
    ghost.className = 'chip-ghost'
    ghost.textContent = item.text
    const paint = solid(look.backgroundColor)
    if (paint) ghost.style.background = paint
    ghost.style.color = look.color
    stage.append(ghost)
    const size = ghost.getBoundingClientRect()
    const from = `translate(${(item.x - size.width / 2).toFixed(1)}px, ${(item.y - size.height / 2).toFixed(1)}px)`
    const to = `translate(${(meetX - size.width / 2).toFixed(1)}px, ${(meetY - size.height / 2).toFixed(1)}px)`
    ghost.animate(
      [
        { transform: `${from} scale(1)`, opacity: 0, offset: 0 },
        { transform: `${from} scale(1.12)`, opacity: 1, offset: 0.2 },
        { transform: `${to} scale(1.05)`, opacity: 1, offset: 0.9 },
        { transform: `${to} scale(0.8)`, opacity: 0, offset: 1 },
      ],
      { duration: FUSE_MS, easing: 'ease-in-out', fill: 'both' },
    )
    item.piece.setAttribute('data-moving', '')
    return ghost
  })
  setTimeout(() => {
    for (const ghost of ghosts) ghost.remove()
    const fused = document.createElement('div')
    fused.className = 'chip-ghost chip-ghost--fused'
    fused.textContent = `${a.text} + ${b.text}`
    stage.append(fused)
    const size = fused.getBoundingClientRect()
    const at = `translate(${(meetX - size.width / 2).toFixed(1)}px, ${(meetY - size.height / 2).toFixed(1)}px)`
    fused.animate(
      [
        { transform: `${at} scale(0.6)`, opacity: 0, offset: 0 },
        { transform: `${at} scale(1.18)`, opacity: 1, offset: 0.14 },
        { transform: `${at} scale(1)`, opacity: 1, offset: 0.28 },
        { transform: `${at} scale(1.05)`, opacity: 1, offset: 0.6 },
        { transform: `${at} scale(1)`, opacity: 1, offset: 0.85 },
        { transform: `${at} scale(1)`, opacity: 0, offset: 1 },
      ],
      { duration: FUSED_MS, easing: 'ease-in-out', fill: 'both' },
    )
    setTimeout(() => {
      fused.remove()
      for (const item of pieces) item.piece.removeAttribute('data-moving')
    }, FUSED_MS)
  }, FUSE_MS)
  return FUSE_MS
}

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
  /** Dónde se suelta: en medio del destino, o justo debajo o encima de él. */
  land: 'center' | 'below' | 'above' = 'center',
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
  const endY =
    land === 'below'
      ? to.bottom - frame.top + 6
      : land === 'above'
        ? to.top - frame.top - size.height - 6
        : to.top + to.height / 2 - frame.top - size.height / 2
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
