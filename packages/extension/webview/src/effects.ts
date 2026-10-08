/**
 * Efectos del lienzo: lo que acompaña a un gesto para que se entienda **qué se le está haciendo a qué**.
 *
 * - **El foco** (`focus`): mientras dura un gesto, lo que no participa se desenfoca y se apaga un poco; lo
 *   que participa se queda nítido. La vista se va sola a lo que importa.
 * - **Las partículas** (`burst`, `trail`): un estallido donde algo llega, se une o nace; una estela detrás
 *   de lo que viaja. Dicen «aquí ha pasado algo», y en qué dirección.
 * - **La onda** (`ring`): un anillo que se abre donde dos cosas se juntan o algo se suelta.
 * - **Deshacerse** (`dissolve`): lo que se quita se va en partículas, no desaparece de golpe.
 *
 * Todo va sobre el lienzo (el `.react-flow`), no dentro de los nodos: no toca el diagrama ni su código. Con
 * «reducir movimiento», no se hace nada.
 */

const reduced = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** De qué color es un efecto: el de la acción (acento), el de algo que nace, o el de algo que se va. */
export type Tone = 'accent' | 'born' | 'gone'

const COLOR: Record<Tone, string> = {
  accent: 'var(--accent)',
  born: 'var(--state-success)',
  gone: 'var(--state-error)',
}

const stageOf = (node: Element) => node.closest<HTMLElement>('.react-flow')

/** El centro de un elemento, en las coordenadas del lienzo. */
export function centerOf(stage: HTMLElement, element: Element): { x: number; y: number } {
  const frame = stage.getBoundingClientRect()
  const box = element.getBoundingClientRect()
  return { x: box.left + box.width / 2 - frame.left, y: box.top + box.height / 2 - frame.top }
}

function dot(stage: HTMLElement, tone: Tone, size: number): HTMLElement {
  const particle = document.createElement('span')
  particle.className = 'fx-dot'
  particle.style.width = `${size}px`
  particle.style.height = `${size}px`
  particle.style.background = COLOR[tone]
  stage.append(particle)
  return particle
}

/** Un estallido de partículas en un punto: algo ha llegado, se ha unido o ha nacido ahí. */
export function burst(
  stage: HTMLElement,
  at: { x: number; y: number },
  tone: Tone = 'accent',
  count = 14,
): void {
  if (reduced()) return
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5
    const reach = 26 + Math.random() * 34
    const particle = dot(stage, tone, 3 + Math.random() * 4)
    const from = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`
    const to = `translate(${(at.x + Math.cos(angle) * reach).toFixed(1)}px, ${(at.y + Math.sin(angle) * reach).toFixed(1)}px)`
    particle
      .animate(
        [
          { transform: `${from} scale(1)`, opacity: 0.95 },
          { transform: `${to} scale(0.2)`, opacity: 0 },
        ],
        { duration: 520 + Math.random() * 260, easing: 'cubic-bezier(0.1, 0.7, 0.3, 1)' },
      )
      .finished.catch(() => undefined)
      .finally(() => {
        particle.remove()
      })
  }
}

/** Un anillo que se abre en un punto: el golpe de algo que se suelta, o de dos cosas que se juntan. */
export function ring(
  stage: HTMLElement,
  at: { x: number; y: number },
  tone: Tone = 'accent',
): void {
  if (reduced()) return
  const wave = document.createElement('span')
  wave.className = 'fx-ring'
  wave.style.borderColor = COLOR[tone]
  stage.append(wave)
  const here = `translate(${(at.x - 12).toFixed(1)}px, ${(at.y - 12).toFixed(1)}px)`
  wave
    .animate(
      [
        { transform: `${here} scale(0.4)`, opacity: 0.9 },
        { transform: `${here} scale(4.2)`, opacity: 0 },
      ],
      { duration: 620, easing: 'cubic-bezier(0.1, 0.7, 0.3, 1)' },
    )
    .finished.catch(() => undefined)
    .finally(() => {
      wave.remove()
    })
}

/**
 * La estela de algo que viaja: mientras dure, va dejando partículas donde está. Devuelve cómo cortarla.
 */
export function trail(stage: HTMLElement, moving: Element, ms: number, tone: Tone = 'accent') {
  if (reduced()) return () => undefined
  const started = performance.now()
  const timer = setInterval(() => {
    if (performance.now() - started > ms || !moving.isConnected) {
      clearInterval(timer)
      return
    }
    const at = centerOf(stage, moving)
    const particle = dot(stage, tone, 4 + Math.random() * 3)
    const jitter = () => (Math.random() - 0.5) * 10
    const here = `translate(${(at.x + jitter()).toFixed(1)}px, ${(at.y + jitter()).toFixed(1)}px)`
    particle
      .animate(
        [
          { transform: `${here} scale(1)`, opacity: 0.7 },
          { transform: `${here} scale(0.1)`, opacity: 0 },
        ],
        { duration: 480, easing: 'ease-out' },
      )
      .finished.catch(() => undefined)
      .finally(() => {
        particle.remove()
      })
  }, 45)
  return () => {
    clearInterval(timer)
  }
}

/**
 * El foco: mientras dura un gesto, lo que no participa se desenfoca y se apaga; lo que participa queda
 * nítido. Devuelve cómo soltarlo (también se suelta solo a los `ms`).
 */
export function focus(nodes: readonly (Element | null | undefined)[], ms: number): () => void {
  const involved = nodes.filter((node): node is Element => node instanceof Element)
  const stage = involved[0] ? stageOf(involved[0]) : null
  if (!stage || reduced()) return () => undefined
  for (const node of involved) node.setAttribute('data-fx', '')
  stage.setAttribute('data-focusing', '')
  let released = false
  const release = () => {
    if (released) return
    released = true
    stage.removeAttribute('data-focusing')
    for (const node of involved) node.removeAttribute('data-fx')
  }
  setTimeout(release, ms)
  return release
}

/** Lo que se quita se deshace en partículas, desde toda su superficie. */
export function dissolve(node: Element): void {
  const stage = stageOf(node)
  if (!stage || reduced()) return
  const frame = stage.getBoundingClientRect()
  const box = node.getBoundingClientRect()
  for (let i = 0; i < 22; i++) {
    const x = box.left - frame.left + Math.random() * box.width
    const y = box.top - frame.top + Math.random() * box.height
    const particle = dot(stage, 'gone', 3 + Math.random() * 4)
    const from = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
    const to = `translate(${(x + (Math.random() - 0.5) * 60).toFixed(1)}px, ${(y - 20 - Math.random() * 50).toFixed(1)}px)`
    particle
      .animate(
        [
          { transform: `${from} scale(1)`, opacity: 0.9 },
          { transform: `${to} scale(0.1)`, opacity: 0 },
        ],
        { duration: 600 + Math.random() * 400, easing: 'ease-out', delay: Math.random() * 180 },
      )
      .finished.catch(() => undefined)
      .finally(() => {
        particle.remove()
      })
  }
}

/** Un nodo acaba de nacer: un destello discreto en su borde (no partículas: nacen muchos seguidos). */
export function spark(node: Element): void {
  const stage = stageOf(node)
  if (!stage || reduced()) return
  ring(stage, centerOf(stage, node), 'born')
}
