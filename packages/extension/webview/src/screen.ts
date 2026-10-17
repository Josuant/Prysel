/**
 * La **pantalla** de un programa en marcha (la de su módulo `pantalla`): lo que se ve en ella, lo que se pulsa
 * y lo que suena. Se construye con las órdenes que va mandando el programa (`apply`), y el lienzo la enseña
 * en su nodo «Pantalla». Aquí no se ejecuta nada: solo se lleva la cuenta (y se toca el sonido).
 */

export type ScreenShape =
  | { shape: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { shape: 'circle'; x: number; y: number; r: number; color: string }
  | { shape: 'line'; x: number; y: number; x2: number; y2: number; color: string; width: number }
  | { shape: 'text'; x: number; y: number; text: string; color: string; size: number }

export interface ScreenState {
  /** `loading`: arrancando; `running`: en marcha (se puede usar); `failed`: falló; `idle`: aún no arrancó. */
  phase: 'idle' | 'loading' | 'running' | 'failed'
  title: string | null
  lines: string[]
  buttons: { id: number; label: string; color?: string }[]
  keys: { id: number; key: string }[]
  /** Partes del lienzo que se pulsan (una tecla dibujada). */
  zones: { id: number; x: number; y: number; w: number; h: number }[]
  /** Lo que se llama al pulsar en cualquier sitio del lienzo (con dónde), si lo hay. */
  touch: number | null
  timers: { id: number; secs: number }[]
  canvas: { w: number; h: number; bg: string; shapes: ScreenShape[] } | null
  /** Lo que imprimió (el final). */
  output: string
  error: { name: string; message: string; line: number | null } | null
  /** Cuántas veces se arrancó: lo que se repite se rehace al cambiar. */
  run: number
}

export const EMPTY_SCREEN: ScreenState = {
  phase: 'idle',
  title: null,
  lines: [],
  buttons: [],
  keys: [],
  zones: [],
  touch: null,
  timers: [],
  canvas: null,
  output: '',
  error: null,
  run: 0,
}

/** Cuánto se guarda de lo que imprime, de líneas de texto y de figuras dibujadas. */
const MAX_OUTPUT = 4000
const MAX_LINES = 40
const MAX_SHAPES = 2000
const MAX_BUTTONS = 48

const num = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)

/** Lo que hace a la pantalla una orden del programa (las que no se entienden no hacen nada). */
export function applyScreen(state: ScreenState, command: Record<string, unknown>): ScreenState {
  switch (command['op']) {
    case 'title':
      return { ...state, title: str(command['text']) }
    case 'text':
      return { ...state, lines: [...state.lines, str(command['text'])].slice(-MAX_LINES) }
    case 'clearText':
      return { ...state, lines: [] }
    case 'button': {
      const id = num(command['id'], -1)
      if (id < 0 || state.buttons.length >= MAX_BUTTONS) return state
      const color = str(command['color'])
      return {
        ...state,
        buttons: [
          ...state.buttons,
          { id, label: str(command['label']), ...(color !== '' ? { color } : {}) },
        ],
      }
    }
    case 'key': {
      const id = num(command['id'], -1)
      return id < 0 ? state : { ...state, keys: [...state.keys, { id, key: str(command['key']) }] }
    }
    case 'zone': {
      const id = num(command['id'], -1)
      if (id < 0) return state
      const zone = {
        id,
        x: num(command['x']),
        y: num(command['y']),
        w: num(command['w']),
        h: num(command['h']),
      }
      return { ...state, zones: [...state.zones, zone].slice(-200) }
    }
    case 'touch': {
      const id = num(command['id'], -1)
      return id < 0 ? state : { ...state, touch: id }
    }
    case 'timer': {
      const id = num(command['id'], -1)
      return id < 0
        ? state
        : {
            ...state,
            timers: [...state.timers, { id, secs: Math.max(0.03, num(command['secs'], 1)) }],
          }
    }
    case 'stop':
      return { ...state, timers: [] }
    case 'canvas':
      return {
        ...state,
        canvas: {
          w: Math.min(1200, Math.max(40, num(command['w'], 400))),
          h: Math.min(900, Math.max(40, num(command['h'], 300))),
          bg: str(command['bg'], 'white'),
          shapes: [],
        },
      }
    case 'clear':
      return state.canvas ? { ...state, canvas: { ...state.canvas, shapes: [] } } : state
    case 'draw': {
      const shape = shapeOf(command)
      if (!shape) return state
      // Dibujar sin haber pedido un lienzo: se pone uno de tamaño normal.
      const canvas = state.canvas ?? { w: 400, h: 300, bg: 'white', shapes: [] }
      return {
        ...state,
        canvas: { ...canvas, shapes: [...canvas.shapes, shape].slice(-MAX_SHAPES) },
      }
    }
    default:
      return state
  }
}

function shapeOf(command: Record<string, unknown>): ScreenShape | null {
  const color = str(command['color'], 'black')
  const x = num(command['x'])
  const y = num(command['y'])
  switch (command['shape']) {
    case 'rect':
      return { shape: 'rect', x, y, w: num(command['w']), h: num(command['h']), color }
    case 'circle':
      return { shape: 'circle', x, y, r: num(command['r']), color }
    case 'line':
      return {
        shape: 'line',
        x,
        y,
        x2: num(command['x2']),
        y2: num(command['y2']),
        color,
        width: num(command['width'], 2),
      }
    case 'text':
      return {
        shape: 'text',
        x,
        y,
        text: str(command['text']),
        color,
        size: num(command['size'], 16),
      }
    default:
      return null
  }
}

/** Arranca de nuevo: todo en blanco, esperando a que el programa diga qué enseña. */
export const restartScreen = (state: ScreenState): ScreenState => ({
  ...EMPTY_SCREEN,
  phase: 'loading',
  run: state.run + 1,
})

/** Lo que imprime, al final de lo que ya había. */
export const withOutput = (state: ScreenState, text: string): ScreenState => ({
  ...state,
  output: (state.output + text).slice(-MAX_OUTPUT),
})

/** ¿Usa el programa la pantalla de Prysel? (Lo importa en su primer nivel.) */
export const usesScreen = (source: string): boolean =>
  /^(?:import\s+pantalla\b|from\s+pantalla\s+import\b)/m.test(source)

// ───────────────────────── las teclas ─────────────────────────

const KEY_NAMES: Record<string, string> = {
  espacio: ' ',
  space: ' ',
  intro: 'Enter',
  enter: 'Enter',
  izquierda: 'ArrowLeft',
  left: 'ArrowLeft',
  derecha: 'ArrowRight',
  right: 'ArrowRight',
  arriba: 'ArrowUp',
  up: 'ArrowUp',
  abajo: 'ArrowDown',
  down: 'ArrowDown',
  escape: 'Escape',
  esc: 'Escape',
  borrar: 'Backspace',
  tab: 'Tab',
}

/** ¿Es esa la tecla que se pulsó? (`nombre`, como lo dice el programa: «a», «espacio», «izquierda»…) */
export function keyMatches(name: string, pressed: string): boolean {
  const wanted = KEY_NAMES[name.trim().toLowerCase()] ?? name
  return wanted.length === 1 ? wanted.toLowerCase() === pressed.toLowerCase() : wanted === pressed
}

/** Cómo se enseña una tecla, para leerla. */
export const keyLabel = (name: string): string =>
  ({ ' ': 'espacio', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' })[
    KEY_NAMES[name.trim().toLowerCase()] ?? ''
  ] ?? name

// ───────────────────────── el sonido ─────────────────────────

let audio: AudioContext | null = null

/** El sonido de la página, creado (o despertado) ahora: llamado al pulsar algo, que es cuando el navegador lo deja. */
export function unlockSound(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Context) return null
  audio ??= new Context()
  if (audio.state === 'suspended') void audio.resume()
  return audio
}

/**
 * Suena una nota: `hz` hercios durante `secs` segundos, empezando dentro de `delay` segundos. Una envolvente
 * corta (ataque rápido, caída suave), como una tecla de piano sencilla. El primer sonido necesita que se haya
 * pulsado algo en la página (así lo exigen los navegadores): lo de antes no suena.
 */
export function playNote(hz: number, secs: number, delay = 0) {
  if (!Number.isFinite(hz) || hz <= 0) return
  const audio = unlockSound()
  if (!audio) return
  const start = audio.currentTime + Math.max(0, delay) + 0.01
  const length = Math.min(8, Math.max(0.05, secs))
  const gain = audio.createGain()
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(0.22, start + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.08, start + Math.min(0.25, length * 0.5))
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length)
  gain.connect(audio.destination)
  for (const [type, ratio, level] of [
    ['triangle', 1, 1],
    ['sine', 2, 0.25],
  ] as const) {
    const voice = audio.createOscillator()
    const mix = audio.createGain()
    voice.type = type
    voice.frequency.setValueAtTime(Math.min(20_000, hz * ratio), start)
    mix.gain.value = level
    voice.connect(mix).connect(gain)
    voice.start(start)
    voice.stop(start + length + 0.05)
  }
}
