import type {
  ChainSteps,
  LoopSeries,
  RunOptions,
  RunResult,
  Summary,
} from '../../../packages/extension/src/kernel.ts'
import type { Engine } from '../../../packages/extension/src/session.ts'
import type { Trace, TraceExtra } from '../../../packages/extension/src/trace.ts'
import PythonWorker from './python.worker.ts?worker'

/**
 * El motor de la web: el mismo contrato que `Kernel` (el de VS Code, con un proceso de Python), pero con
 * Pyodide en un worker. La sesión de ejecución (`session.ts`) lo usa sin saber la diferencia.
 */

interface Event {
  ev: string
  id?: string
  [key: string]: unknown
}

interface Pending {
  result: RunResult
  options: RunOptions
  resolve: (result: RunResult) => void
}

/** De dónde se carga el núcleo de Pyodide: la carpeta `pyodide/` junto a la página. */
const pyodideIndex = () => new URL('pyodide/', document.baseURI).href

export class WebKernel implements Engine {
  private readonly worker: Worker
  private readonly pending = new Map<string, Pending>()
  private readonly waiting = new Map<string, (event: Event) => void>()
  private counter = 0
  private dead: Error | null = null
  info: { python: string } | null = null

  private constructor(private readonly onDeath: (error: Error) => void) {
    this.worker = new PythonWorker()
    this.worker.onmessage = (message: MessageEvent<Event>) => this.handle(message.data)
    this.worker.onerror = (error) =>
      this.die(new Error(error.message || 'El motor de Python falló.'))
  }

  /** Arranca Pyodide (la primera vez baja unos megas: el núcleo de Python). */
  static start(onDeath: (error: Error) => void = () => undefined): Promise<WebKernel> {
    const kernel = new WebKernel(onDeath)
    return new Promise((resolve, reject) => {
      kernel.waiting.set('ready', (event) => {
        kernel.waiting.delete('ready')
        kernel.info = { python: String(event['python']) }
        resolve(kernel)
      })
      kernel.waiting.set('fatal', (event) => {
        kernel.dispose()
        reject(new Error(`No se pudo cargar Python en el navegador: ${String(event['message'])}`))
      })
      kernel.worker.postMessage({ op: 'boot', index: pyodideIndex() })
    })
  }

  get alive(): boolean {
    return this.dead === null
  }

  private send(request: Record<string, unknown>) {
    if (this.dead) throw this.dead
    this.worker.postMessage({ ...request, index: pyodideIndex() })
  }

  private handle(event: Event) {
    if (event.ev === 'ready' || event.ev === 'fatal')
      return void this.waiting.get(event.ev)?.(event)
    if (event.ev === 'vars') return void this.waiting.get(`vars:${event.id}`)?.(event)
    if (event.ev === 'reset') return void this.waiting.get('reset')?.(event)
    if (event.ev === 'trace') return void this.waiting.get(`trace:${event.id}`)?.(event)
    const run = event.id === undefined ? undefined : this.pending.get(event.id)
    if (!run) return
    const { result, options } = run
    switch (event.ev) {
      case 'stream': {
        const name = event['name'] === 'stderr' ? 'stderr' : 'stdout'
        const text = String(event['text'])
        result[name] += text
        options.onStream?.(name, text)
        break
      }
      case 'iter':
        options.onIteration?.({
          frag: String(event['frag']),
          loop: String(event['loop']),
          n: Number(event['n']),
          idx: event['idx'] as number[],
          names: event['names'] as LoopSeries['names'],
          done: event['done'] === true,
        })
        break
      case 'steps':
        options.onSteps?.({
          frag: String(event['frag']),
          chain: String(event['chain']),
          previews: event['previews'] as ChainSteps['previews'],
        })
        break
      case 'result':
        result.result = event['summary'] as Summary
        break
      case 'value':
        result.values[String(event['name'])] = event['summary'] as Summary
        break
      case 'figure':
        result.figures.push({ mime: String(event['mime']), data: String(event['data']) })
        break
      case 'error':
        result.error = {
          name: String(event['ename']),
          message: String(event['evalue']),
          line: typeof event['line'] === 'number' ? event['line'] : null,
          traceback: String(event['traceback']),
        }
        break
      case 'done':
        result.ok = event['ok'] === true
        result.ms = Number(event['ms'])
        this.pending.delete(event.id as string)
        run.resolve(result)
        break
    }
  }

  private die(error: Error) {
    if (this.dead) return
    this.dead = error
    this.worker.terminate()
    this.onDeath(error)
    for (const [id, run] of this.pending) {
      run.result.ok = false
      run.result.error = { name: 'KernelDied', message: error.message, line: null, traceback: '' }
      run.resolve(run.result)
      this.pending.delete(id)
    }
    for (const [key, waiter] of this.waiting) {
      if (key.startsWith('trace:')) waiter({ ev: 'trace', died: true })
    }
  }

  run(code: string, options: RunOptions = {}): Promise<RunResult> {
    const id = options.id ?? `run${++this.counter}`
    const result: RunResult = { ok: false, ms: 0, stdout: '', stderr: '', values: {}, figures: [] }
    if (this.dead) {
      result.error = { name: 'KernelDied', message: this.dead.message, line: null, traceback: '' }
      return Promise.resolve(result)
    }
    return new Promise((resolve) => {
      this.pending.set(id, { result, options, resolve })
      this.send({ op: 'run', id, code, watch: options.watch ?? [] })
    })
  }

  trace(
    code: string,
    limit = 20_000,
    safe = false,
    wide = false,
    extra: TraceExtra = {},
  ): Promise<Trace> {
    const id = `t${++this.counter}`
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(this.dead)
      this.waiting.set(`trace:${id}`, (event) => {
        this.waiting.delete(`trace:${id}`)
        if (event['died']) return reject(new Error('Se cortó la ejecución.'))
        resolve({
          events: event['events'] as Trace['events'],
          truncated: event['truncated'] === true,
          error: (event['error'] as Trace['error']) ?? null,
          output: String(event['output'] ?? ''),
        })
      })
      this.send({ op: 'trace', id, code, limit, safe, wide, ...extra })
    })
  }

  /** En Pyodide no se puede cortar un programa a medias: se termina el motor (y se arranca otro al pedirlo). */
  interrupt() {
    this.die(new Error('Ejecución cortada: el motor se reinicia.'))
  }

  dispose() {
    if (!this.dead) {
      this.dead = new Error('Motor cerrado.')
      this.worker.terminate()
    }
  }
}
