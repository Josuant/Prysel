import ScreenWorker from './screen.worker.ts?worker'

/**
 * El programa en marcha para usarlo (su `pantalla`), en un worker aparte del que lo mira línea a línea:
 * aquí se arranca, recibe las pulsaciones y cuenta lo que hace. Si se queda colgado (un bucle sin fin), se
 * termina el worker y se arranca otro.
 */

export type ScreenEvent =
  | { ev: 'screen'; command: Record<string, unknown> }
  | { ev: 'out'; text: string }
  | { ev: 'error'; name: string; message: string; line: number | null }
  | { ev: 'idle' }
  | { ev: 'loading' }
  | { ev: 'fatal'; message: string }

/**
 * Lo más que se espera a que el programa atienda una pulsación antes de darlo por colgado; y a que arranque
 * (la primera vez se carga Python, y quizá alguna librería).
 */
const HUNG_MS = 8000
const START_MS = 45_000

const pyodideIndex = () => new URL('pyodide/', document.baseURI).href

export class ScreenRunner {
  private worker: Worker | null = null
  /** Cuándo se le pidió lo último que aún no ha terminado (`null`: está libre). */
  private busySince: number | null = null
  private watchdog: number | undefined

  constructor(private readonly onEvent: (event: ScreenEvent) => void) {}

  private spawn(): Worker {
    const worker = new ScreenWorker()
    worker.onmessage = (message: MessageEvent<Record<string, unknown>>) => {
      const event = message.data
      if (event['ev'] === 'idle') {
        this.busySince = null
        window.clearTimeout(this.watchdog)
      }
      if (event['ev'] === 'ready') return
      this.onEvent(event as unknown as ScreenEvent)
    }
    worker.onerror = (error) => {
      this.onEvent({ ev: 'fatal', message: error.message || 'El motor de Python se paró.' })
    }
    worker.postMessage({ op: 'boot', index: pyodideIndex() })
    return worker
  }

  private send(request: Record<string, unknown>, patience = HUNG_MS) {
    this.worker ??= this.spawn()
    this.busySince ??= performance.now()
    window.clearTimeout(this.watchdog)
    this.watchdog = window.setTimeout(() => {
      this.hung()
    }, patience)
    this.worker.postMessage({ ...request, index: pyodideIndex() })
  }

  /** Lleva demasiado sin contestar: un bucle sin fin. Se termina y se dice. */
  private hung() {
    if (this.busySince === null) return
    this.kill()
    this.onEvent({
      ev: 'error',
      name: 'Colgado',
      message:
        'Se quedó dando vueltas sin acabar (¿un bucle sin fin?). Para lo que se repite, usa pantalla.cada(segundos, función).',
      line: null,
    })
  }

  private kill() {
    this.worker?.terminate()
    this.worker = null
    this.busySince = null
    window.clearTimeout(this.watchdog)
  }

  /** Arranca el programa de cero (si había otro en marcha, se deja). */
  start(code: string) {
    // Si lo anterior sigue ocupado (colgado o muy lento), no se le espera: se empieza en un worker nuevo.
    if (this.busySince !== null) this.kill()
    this.onEvent({ ev: 'loading' })
    this.send({ op: 'start', code }, START_MS)
  }

  /** Una pulsación (un botón, una tecla, o lo que se repite con `cada`). */
  press(id: number, args: readonly (string | number)[] = []) {
    if (!this.worker) return
    this.send({ op: 'press', id, args: [...args] })
  }

  /** Está ocupado atendiendo algo (para no amontonar lo que se repite). */
  get busy(): boolean {
    return this.busySince !== null
  }

  stop() {
    this.kill()
  }
}
