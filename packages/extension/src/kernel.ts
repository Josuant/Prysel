import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * El cliente del motor de ejecución (`runtime/prysel_runner.py`): lanza un Python, le pide que ejecute
 * fragmentos de código en un espacio de nombres vivo y devuelve lo que ocurrió — la salida, el valor
 * resumido de cada nombre pedido, las figuras y el error, si lo hubo.
 *
 * No depende de `vscode`: lo mismo sirve dentro de la extensión y en las pruebas. Solo necesita un
 * intérprete de Python; no hace falta `ipykernel` ni ZeroMQ.
 */

/** Lo que el lienzo enseña de un valor sin traerlo entero. */
export interface Summary {
  type: string
  module: string
  shape?: number[]
  dtype?: string
  device?: string
  bytes?: number
  length?: number
  repr?: string
  items?: string[]
  sample?: (number | string | null)[]
  range?: (number | null)[]
  /** Un DataFrame: sus columnas (con tipo y nulos) y las primeras filas. */
  table?: {
    columns: { name: string; dtype: string; nulls?: number }[]
    rows: unknown[][]
  }
  /** Una imagen de PIL: un PNG en miniatura, en Base64. */
  image?: string
  size?: number[]
}

export interface RunError {
  name: string
  message: string
  /** La línea, dentro del fragmento ejecutado (base 1), donde falló. */
  line: number | null
  traceback: string
}

export interface RunResult {
  ok: boolean
  ms: number
  stdout: string
  stderr: string
  /** El valor de la última expresión (como en Jupyter), si la había y no era `None`. */
  result?: Summary
  /** Los nombres pedidos con `watch` que están definidos después de ejecutar. */
  values: Record<string, Summary>
  figures: { mime: string; data: string }[]
  error?: RunError
}

/**
 * Lo que valen, vuelta a vuelta, los nombres que cambia un bucle. `frag` es la ejecución que definió el
 * bucle (puede no ser la que corre ahora: una función con un bucle, llamada más tarde) y `loop` dónde
 * está, como `línea:columna` dentro de ese fragmento. Los valores son números o una descripción corta.
 */
export interface LoopSeries {
  frag: string
  loop: string
  /** Cuántas vueltas ha dado. */
  n: number
  /** Qué vueltas (base 0) tienen valor: todas al principio y, en un bucle largo, una muestra. */
  idx: number[]
  names: Record<string, (number | string | null)[]>
  /** El bucle acabó (o se cortó): la última vuelta ya está anotada. */
  done: boolean
}

export interface RunOptions {
  id?: string
  /** Nombres cuyo valor se resume al terminar. */
  watch?: readonly string[]
  /** Cada trozo de salida según se produce (un bucle largo enseña su progreso). */
  onStream?: (name: 'stdout' | 'stderr', text: string) => void
  /** Cada vez que un bucle anota sus vueltas (con aviso espaciado, no una por vuelta). */
  onIteration?: (series: LoopSeries) => void
}

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

export interface KernelOptions {
  python: string
  /** Desde dónde se ejecuta: es donde se resuelven las rutas relativas y los módulos del proyecto. */
  cwd?: string
}

/** Dónde está el ejecutor: junto a la extensión, o —ya empaquetado— el que se le indique. */
export const runnerPath = (override?: string): string => {
  if (override) return override
  // Empaquetada, junto al código compilado (`dist/runtime`); en desarrollo, en la carpeta de la extensión.
  const bundled = join(__dirname, 'runtime', 'prysel_runner.py')
  return existsSync(bundled) ? bundled : join(__dirname, '..', 'runtime', 'prysel_runner.py')
}

export class Kernel {
  private readonly pending = new Map<string, Pending>()
  private readonly waiting = new Map<string, (event: Event) => void>()
  private socket: Socket | null = null
  private candidate: Socket | null = null
  private buffer = ''
  private counter = 0
  private dead: Error | null = null
  private startupErrors = ''
  private onDeath: ((error: Error) => void) | null = null
  info: { python: string; cwd: string; pid: number } | null = null

  private constructor(
    private readonly child: ChildProcess,
    private readonly token: string,
  ) {
    child.on('exit', (code) =>
      this.die(new Error(`El motor de ejecución terminó (código ${code}).`)),
    )
    child.on('error', (error) => this.die(error))
    // Lo que el intérprete escribe fuera del protocolo (un fallo al arrancar) no debe perderse.
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (text: string) => {
      this.startupErrors += text
    })
  }

  /**
   * Arranca el motor y espera a que diga que está listo. El protocolo va por un socket local que el
   * motor abre hacia nosotros (con una clave que solo conoce él), no por la entrada estándar: en
   * Windows una lectura bloqueada sobre esa tubería cuelga imports como el de numpy.
   */
  static async start(options: KernelOptions & { runner?: string }): Promise<Kernel> {
    const token = randomBytes(16).toString('hex')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const child = spawn(options.python, ['-u', runnerPath(options.runner), String(port)], {
      cwd: options.cwd,
      env: { ...process.env, MPLBACKEND: 'Agg', PYTHONIOENCODING: 'utf-8', PRYSEL_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const kernel = new Kernel(child, token)
    server.on('connection', (socket) => kernel.attach(socket))
    try {
      const ready = await new Promise<Event>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('El motor de ejecución no respondió al arrancar.')),
          30_000,
        )
        kernel.waiting.set('ready', (event) => {
          clearTimeout(timer)
          resolve(event)
        })
        kernel.onDeath = (error) => {
          clearTimeout(timer)
          reject(
            new Error(`${error.message}${kernel.startupErrors ? `\n${kernel.startupErrors}` : ''}`),
          )
        }
      })
      kernel.info = {
        python: String(ready['python']),
        cwd: String(ready['cwd']),
        pid: Number(ready['pid']),
      }
      return kernel
    } catch (error) {
      kernel.dispose()
      throw error
    } finally {
      kernel.onDeath = null
      // Solo el motor debía conectarse: cerrado el servidor, nadie más puede.
      server.close()
    }
  }

  private attach(socket: Socket) {
    // Solo se atiende la primera conexión: una segunda no es del motor.
    if (this.candidate) return void socket.destroy()
    this.candidate = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.feed(chunk, socket))
    socket.on('close', () => this.die(new Error('El motor de ejecución cerró la conexión.')))
    socket.on('error', () => undefined)
  }

  private feed(chunk: string, from: Socket) {
    this.buffer += chunk
    let at = this.buffer.indexOf('\n')
    while (at >= 0) {
      const line = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 1)
      at = this.buffer.indexOf('\n')
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as Event
        // El primer mensaje es la clave: sin ella, quien se conectó no es el motor.
        if (!this.socket) {
          if (event.ev === 'hello' && event['token'] === this.token) this.socket = from
          else from.destroy()
          continue
        }
        this.handle(event)
      } catch {
        // Una línea que no es del protocolo: se ignora.
      }
    }
  }

  private handle(event: Event) {
    if (event.ev === 'ready') return void this.waiting.get('ready')?.(event)
    if (event.ev === 'vars') return void this.waiting.get(`vars:${event.id}`)?.(event)
    if (event.ev === 'reset') return void this.waiting.get('reset')?.(event)
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
    this.onDeath?.(error)
    for (const [id, run] of this.pending) {
      run.result.ok = false
      run.result.error = { name: 'KernelDied', message: error.message, line: null, traceback: '' }
      run.resolve(run.result)
      this.pending.delete(id)
    }
  }

  get alive(): boolean {
    return this.dead === null
  }

  private send(request: Record<string, unknown>) {
    if (this.dead) throw this.dead
    if (!this.socket) throw new Error('El motor de ejecución aún no está conectado.')
    this.socket.write(`${JSON.stringify(request)}\n`)
  }

  /** Ejecuta un fragmento en el espacio de nombres del motor. Nunca rechaza: un fallo es `ok: false`. */
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

  /** Lo que hay definido ahora, resumido. */
  vars(): Promise<Record<string, Summary>> {
    const id = `v${++this.counter}`
    return new Promise((resolve, reject) => {
      this.waiting.set(`vars:${id}`, (event) => {
        this.waiting.delete(`vars:${id}`)
        resolve(event['vars'] as Record<string, Summary>)
      })
      try {
        this.send({ op: 'vars', id })
      } catch (error) {
        reject(error)
      }
    })
  }

  /** Vacía el espacio de nombres. */
  reset(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiting.set('reset', () => {
        this.waiting.delete('reset')
        resolve()
      })
      try {
        this.send({ op: 'reset' })
      } catch (error) {
        reject(error)
      }
    })
  }

  /** Corta lo que se esté ejecutando (el fragmento acaba con un `KeyboardInterrupt`). */
  interrupt() {
    if (!this.dead) this.send({ op: 'interrupt' })
  }

  dispose() {
    if (!this.dead) {
      try {
        this.send({ op: 'shutdown' })
      } catch {
        // ya no estaba
      }
    }
    const { child, socket } = this
    setTimeout(() => {
      socket?.destroy()
      child.kill()
    }, 300).unref()
  }
}
