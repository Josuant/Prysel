import type { WebHost } from './host.ts'

/**
 * Un guion de prueba: una sesión de voz escrita. La página «dice» cada frase por quien prueba, palabra a
 * palabra y con sus pausas, por el mismo camino que el micrófono (el reconocimiento de voz del navegador se
 * cambia por uno de mentira que dicta el guion). Así una sesión de cinco minutos hablando se repite con un
 * clic, siempre igual, y se puede comparar con la de ayer.
 *
 * El formato, una línea por frase:
 *
 *     # un comentario
 *     Crea una clase llamada animal
 *     En el programa principal … manda llamar al método     ← «…»: una pausa para pensar, a mitad de frase
 *     > espera 3                                            ← segundos sin decir nada
 *     > nuevo                                               ← empieza con el programa vacío
 */

/** Cómo le llegan las frases al chat: la misma forma que el reconocimiento de voz del navegador. */
interface Listener {
  onresult:
    | ((event: {
        resultIndex: number
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
      }) => void)
    | null
  onend: (() => void) | null
}

let listener: Listener | null = null
const attach = (target: Listener | null) => {
  listener = target
}

/** Un reconocimiento de voz que no escucha: dice lo que el guion le manda. */
class ScriptedSpeech implements Listener {
  lang = ''
  interimResults = true
  continuous = true
  onresult: Listener['onresult'] = null
  onend: Listener['onend'] = null
  onerror: ((event: { error?: string }) => void) | null = null
  start() {
    attach(this)
  }
  stop() {
    if (listener === this) attach(null)
    this.onend?.()
  }
}

const hear = (transcript: string, isFinal: boolean) => {
  const result = Object.assign([{ transcript }], { isFinal })
  listener?.onresult?.({ resultIndex: 0, results: [result] })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface ScriptOptions {
  /** Lo que se tarda en decir cada palabra. */
  wordMs?: number
  /** Lo que tarda el navegador en dar una frase por terminada tras callar. */
  finalMs?: number
  /** Lo que dura una pausa para pensar («…»). */
  pauseMs?: number
  /** Qué línea se está diciendo (para enseñarlo). */
  onLine?: (line: string, index: number, total: number) => void
  signal?: AbortSignal
}

export interface ScriptRun {
  lines: { said: string; at: number; settledMs: number }[]
  stopped: boolean
}

type Scope = typeof globalThis & { __pryselSpeech?: unknown }

/** El botón del micrófono del chat: se abre y se cierra como lo haría quien prueba. */
const mic = () => document.querySelector<HTMLButtonElement>('.chat__mic')

/**
 * Ejecuta un guion contra la página tal como está (con sus modelos y sus claves). Devuelve lo que se dijo y
 * cuánto tardó en asentarse cada frase. Los registros de consultas y de cambios los lleva el anfitrión.
 */
export async function runScript(
  host: WebHost,
  text: string,
  options: ScriptOptions = {},
): Promise<ScriptRun> {
  const { wordMs = 170, finalMs = 800, pauseMs = 1700, onLine, signal } = options
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  const run: ScriptRun = { lines: [], stopped: false }
  const started = performance.now()
  const scope = globalThis as Scope
  // El micrófono, cerrado si estaba abierto con el de verdad; y abierto con el del guion.
  if (mic()?.hasAttribute('data-listening')) mic()?.click()
  scope.__pryselSpeech = ScriptedSpeech
  await sleep(120)
  mic()?.click()
  await sleep(250)
  /** Espera a que lo pedido se haya asentado: nada construyéndose ni ninguna consulta en marcha. */
  const settle = async () => {
    const from = performance.now()
    let calm = 0
    while (calm < 1800 && performance.now() - from < 120_000 && !signal?.aborted) {
      await sleep(150)
      calm = host.busy ? 0 : calm + 150
    }
    return Math.round(performance.now() - from)
  }
  try {
    for (const [index, line] of lines.entries()) {
      if (signal?.aborted) break
      onLine?.(line, index, lines.length)
      const wait = /^>\s*espera\s+(\d+(?:[.,]\d+)?)/i.exec(line)?.[1]
      if (wait !== undefined) {
        await sleep(Number(wait.replace(',', '.')) * 1000)
        continue
      }
      if (/^>\s*nuevo\b/i.test(line)) {
        host.open({ name: 'programa.py', text: '', lesson: null })
        await sleep(600)
        continue
      }
      const at = Math.round(performance.now() - started)
      // Cada tramo entre pausas es lo que el navegador daría por una frase: se dice palabra a palabra, y
      // tras callar un momento, llega cerrada.
      for (const stretch of line.split(/\s*(?:…|\.\.\.)\s*/).filter((part) => part !== '')) {
        const words = stretch.split(/\s+/)
        for (let count = 1; count <= words.length && !signal?.aborted; count++) {
          hear(words.slice(0, count).join(' '), false)
          await sleep(wordMs)
        }
        await sleep(finalMs)
        hear(stretch, true)
        await sleep(Math.max(0, pauseMs - finalMs))
      }
      run.lines.push({ said: line, at, settledMs: await settle() })
    }
  } finally {
    run.stopped = signal?.aborted === true
    if (mic()?.hasAttribute('data-listening')) mic()?.click()
    delete scope.__pryselSpeech
  }
  return run
}

/** Guiones de serie: las sesiones que ya han enseñado algo, para volver a pasarlas tras cada cambio. */
export const SCRIPTS: { id: string; title: string; text: string }[] = [
  {
    id: 'calculadora',
    title: 'Calculadora: función → clase → usarla',
    text: [
      '> nuevo',
      'Crea la función sumar',
      'Ahora mete esa función a una clase Calculadora',
      'Ahora instancia un objeto de esa clase',
      'Ahora imprime la suma de 3 más 4',
      'Pero usando la clase calculadora',
    ].join('\n'),
  },
  {
    id: 'cajero',
    title: 'Cajero: una clase que crece y se corrige',
    text: [
      '> nuevo',
      "Crea una clase en Python que simule un cajero automático. Debe empezar en el estado 'Esperando Tarjeta'. Cuando se inserte, pasa al estado 'Pidiendo PIN'",
      "Añade un método para validar el PIN. Si el PIN es '1234', cambia el estado a 'Menú Principal'",
      "Modifica el validador del PIN. Si el usuario se equivoca 3 veces seguidas, cambia el estado a 'Tarjeta Bloqueada' y no permitas hacer más operaciones",
      'Después de insertar la tarjeta, se debe de validar el pin',
      'No, eso no, que el pin se pida por teclado al insertar la tarjeta',
    ].join('\n'),
  },
  {
    id: 'zoo',
    title: 'Zoo: hablando con pausas, como de verdad',
    text: [
      '> nuevo',
      'Crea una clase llamada animal',
      'Una clase llamada perro … que hereda de la clase animal',
      'Ahora crea … un objeto de tipo perro',
      'Añade a la clase perro un método para ladrar',
      'Ahora crea una clase … llamada gato … que también hereda de animal',
      'Crea un objeto gato',
      'Borra el objeto gato',
      'Ahora un método para calcular la edad de un perro … dentro de la clase perro',
      'En el programa principal … manda llamar al método para calcular … la edad del perro',
      'Imprime el resultado',
    ].join('\n'),
  },
  {
    id: 'tablero',
    title: 'Tablero: qué hace cada función, comprobado',
    text: [
      '> nuevo',
      'Crea una función mostrar tablero que reciba una matriz de ceros y unos e imprima un asterisco por cada uno y un punto por cada cero',
      'Crea una función contar vivas que devuelva cuántos unos hay en el tablero',
      'Crea un tablero de tres por tres y muéstralo',
      'No, los ceros que sean espacios',
    ].join('
'),
  },
  {
    id: 'gestos',
    title: 'Gestos: mover, envolver, juntar, deshacer',
    text: [
      '> nuevo',
      'Crea una función sumar que sume dos números',
      'Ahora crea una función restar',
      'Fusiona sumar y restar',
      'No, eso no',
      'Mete la función sumar en una clase Calculadora',
      'Mueve la función restar dentro de la clase Calculadora',
      'Ver la clase Calculadora',
      'Ver el programa principal',
      'Duplica la función restar',
      'Deshazlo',
    ].join('\n'),
  },
]
