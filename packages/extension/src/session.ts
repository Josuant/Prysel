import type { Program } from '@prysel/python'
import type { Kernel, LoopSeries, RunResult, Summary } from './kernel.ts'
import {
  freshness,
  planAll,
  planRun,
  reconcile,
  statements,
  topLevelOf,
  fileLine,
  type Ran,
  type Statement,
} from './plan.ts'
import type { Assets, KernelStatus, LoopView, RunView } from './runs.ts'

/**
 * Una sesión de ejecución: el motor de un documento y lo que se sabe de cada sentencia que corrió.
 *
 * Guarda un registro por sentencia (con el texto con el que corrió, para saber si sigue valiendo),
 * planifica qué ejecutar con `plan.ts`, las ejecuta en orden y avisa de cada cambio. No sabe nada de
 * VS Code: quien la usa le da una forma de arrancar el motor y de enterarse de los cambios.
 */

interface RunRecord extends Ran {
  ms: number
  values: Record<string, Summary>
  result?: Summary
  stdout: string
  stderr: string
  assets?: Assets
  error?: RunResult['error']
  line: number
}

export type SessionChange = { type: 'views' } | { type: 'assets'; seq: number; assets: Assets }

/** Cuánta salida se conserva por sentencia: un bucle que imprime miles de líneas no llena el mensaje. */
const MAX_OUTPUT = 8_000
const MAX_FIGURES = 4

const tail = (text: string) => (text.length <= MAX_OUTPUT ? text : `…${text.slice(-MAX_OUTPUT)}`)

/** Separa lo pesado de un resumen (la miniatura de una imagen) de lo que se manda siempre. */
function light(summary: Summary, name: string, images: Record<string, string>): Summary {
  if (summary.image === undefined) return summary
  images[name] = summary.image
  const rest = { ...summary }
  delete rest.image
  return rest
}

export class Session {
  status: KernelStatus = 'stopped'
  /** Por qué no pudo arrancar el motor, si no pudo. */
  problem: string | null = null

  private kernel: Kernel | null = null
  private stmts: Statement[] = []
  private top = new Map<string, string>()
  private records = new Map<string, RunRecord>()
  private running: { id: string; hash: string } | null = null
  private seq = 0
  /** Qué sentencia (por su texto) ejecutó cada fragmento: un bucle dentro de una función anota con el del fragmento que la definió. */
  private fragments = new Map<string, string>()
  /** Los valores por vuelta de cada bucle, por `texto de la sentencia|línea:columna`. */
  private loops = new Map<string, LoopSeries>()
  private queue: Promise<void> = Promise.resolve()
  private cancelled = false
  private disposed = false

  constructor(
    private readonly start: () => Promise<Kernel>,
    private readonly notify: (change: SessionChange) => void,
  ) {}

  /** El programa cambió: los resultados siguen a sus sentencias, y lo editado vuelve a «nunca ejecutado». */
  update(program: Program, source: string) {
    const next = statements(program, source)
    this.records = reconcile(this.records, this.stmts, next)
    this.stmts = next
    this.top = topLevelOf(program)
    // Lo que se anotó de una sentencia que ya no existe no vale.
    const alive = new Set(next.map((stmt) => stmt.hash))
    for (const key of this.loops.keys())
      if (!alive.has(key.split('|')[0] ?? '')) this.loops.delete(key)
    if (this.running) {
      // Lo que se está ejecutando sigue siendo la misma sentencia aunque se haya movido de línea.
      const { hash } = this.running
      const now = next.find((stmt) => stmt.hash === hash)
      if (now) this.running = { id: now.id, hash }
    }
  }

  /** El estado de cada sentencia, listo para enseñarse. */
  views(): Record<string, RunView> {
    const state = freshness(this.stmts, this.records)
    const views: Record<string, RunView> = {}
    for (const stmt of this.stmts) {
      const record = this.records.get(stmt.id)
      const isRunning = this.running?.id === stmt.id
      const current = state.get(stmt.id) ?? 'never'
      const view: RunView = { state: isRunning ? 'running' : current, hash: stmt.hash }
      if (record && record.hash === stmt.hash) {
        view.seq = record.seq
        view.ms = record.ms
        if (Object.keys(record.values).length > 0) view.values = record.values
        if (record.result) view.result = record.result
        if (record.stdout) view.stdout = tail(record.stdout)
        if (record.stderr) view.stderr = tail(record.stderr)
        if (record.assets) view.assets = true
        if (record.error) {
          view.error = {
            name: record.error.name,
            message: record.error.message,
            line: fileLine(record.line, record.error.line),
            traceback: record.error.traceback,
          }
        }
      }
      const loops = this.loopsOf(stmt.hash)
      if (loops) view.loops = loops
      views[stmt.id] = view
    }
    return views
  }

  /** Los bucles de una sentencia con sus valores por vuelta. */
  private loopsOf(hash: string): Record<string, LoopView> | undefined {
    const found: Record<string, LoopView> = {}
    for (const [key, series] of this.loops) {
      const [owner, loop] = key.split('|')
      if (owner !== hash || loop === undefined) continue
      found[loop] = { n: series.n, idx: series.idx, names: series.names, done: series.done }
    }
    return Object.keys(found).length > 0 ? found : undefined
  }

  /** Lo que un bucle anota mientras corre: se guarda con la sentencia que lo definió y se avisa. */
  private onLoop(series: LoopSeries) {
    const hash = this.fragments.get(series.frag)
    if (hash === undefined) return
    this.loops.set(`${hash}|${series.loop}`, series)
    this.notify({ type: 'views' })
  }

  /** Las imágenes de una ejecución, por su orden (`seq`). */
  assetsOf(seq: number): Assets | undefined {
    for (const record of this.records.values()) if (record.seq === seq) return record.assets
    return undefined
  }

  /** Las imágenes de todas las ejecuciones guardadas: es lo que necesita un lienzo que se abre de nuevo. */
  allAssets(): { seq: number; assets: Assets }[] {
    return [...this.records.values()].flatMap((record) =>
      record.assets ? [{ seq: record.seq, assets: record.assets }] : [],
    )
  }

  /** A qué sentencia de primer nivel pertenece un nodo. */
  statementOf(nodeId: string): string | undefined {
    return this.top.get(nodeId)
  }

  /**
   * Ejecuta lo pedido: los nodos indicados y, antes, lo que necesitan y no está al día; o todo. Las
   * peticiones se encolan: una segunda no interrumpe la primera. Se detiene en el primer error.
   */
  run(nodeIds: readonly string[] | 'all'): Promise<void> {
    const state = freshness(this.stmts, this.records)
    const plan =
      nodeIds === 'all'
        ? planAll(this.stmts)
        : planRun(
            this.stmts,
            [
              ...new Set(
                nodeIds.flatMap((id) => {
                  const top = this.top.get(id)
                  return top === undefined ? [] : [top]
                }),
              ),
            ],
            state,
          )
    // Se congela lo que se va a ejecutar: si el documento cambia mientras corre, no se mezcla.
    const planned = plan.flatMap((id) => {
      const stmt = this.stmts.find((s) => s.id === id)
      return stmt ? [stmt] : []
    })
    const job = this.queue.then(() => this.execute(planned))
    this.queue = job.catch(() => undefined)
    return job
  }

  private async execute(planned: readonly Statement[]) {
    if (this.disposed || planned.length === 0) return
    this.cancelled = false
    this.problem = null
    if (!this.kernel || !this.kernel.alive) {
      this.status = 'starting'
      this.notify({ type: 'views' })
      try {
        this.kernel = await this.start()
      } catch (error) {
        this.kernel = null
        this.status = 'dead'
        this.problem = error instanceof Error ? error.message : String(error)
        this.notify({ type: 'views' })
        return
      }
    }
    const kernel = this.kernel
    for (const stmt of planned) {
      if (this.cancelled || this.disposed) break
      this.status = 'busy'
      this.running = { id: stmt.id, hash: stmt.hash }
      this.notify({ type: 'views' })
      const fragment = `s${++this.seq}`
      this.fragments.set(fragment, stmt.hash)
      // Se vuelve a ejecutar: lo que anotaron sus bucles la vez anterior ya no vale.
      for (const key of [...this.loops.keys()]) {
        if (key.startsWith(`${stmt.hash}|`)) this.loops.delete(key)
      }
      // Solo se recuerdan los últimos fragmentos: un programa largo no los acumula sin fin.
      while (this.fragments.size > 500)
        this.fragments.delete(this.fragments.keys().next().value ?? '')
      const result = await kernel.run(stmt.code, {
        id: fragment,
        watch: stmt.names,
        onIteration: (series) => {
          this.onLoop(series)
        },
      })
      const at = this.running?.id ?? stmt.id
      this.running = null
      if (result.error?.name === 'KernelDied') {
        // El espacio de nombres se perdió con el proceso: nada de lo anterior vale ya.
        this.kernel = null
        this.status = 'dead'
        this.problem = result.error.message
        this.records.clear()
        this.loops.clear()
        this.notify({ type: 'views' })
        return
      }
      this.store(at, stmt, result)
      if (!result.ok) break
    }
    this.status = this.kernel?.alive ? 'idle' : 'dead'
    this.notify({ type: 'views' })
  }

  private store(id: string, stmt: Statement, result: RunResult) {
    // La sentencia pudo cambiar de sitio o de texto mientras corría: el resultado va a la que sigue siendo ella.
    const current = this.stmts.find((s) => s.id === id && s.hash === stmt.hash)
    const target = current ?? this.stmts.find((s) => s.hash === stmt.hash)
    if (!target) return
    const images: Record<string, string> = {}
    const values = Object.fromEntries(
      Object.entries(result.values).map(([name, summary]) => [name, light(summary, name, images)]),
    )
    const shown = result.result ? light(result.result, '_', images) : undefined
    const figures = result.figures.slice(0, MAX_FIGURES)
    const seq = this.seq
    const assets: Assets | undefined =
      figures.length > 0 || Object.keys(images).length > 0 ? { figures, images } : undefined
    this.records.set(target.id, {
      hash: target.hash,
      seq,
      ok: result.ok,
      ms: result.ms,
      values,
      ...(shown ? { result: shown } : {}),
      stdout: result.stdout,
      stderr: result.stderr,
      ...(assets ? { assets } : {}),
      ...(result.error ? { error: result.error } : {}),
      line: target.line,
    })
    if (assets) this.notify({ type: 'assets', seq, assets })
  }

  /** Corta lo que se esté ejecutando y descarta lo que quedaba por ejecutar. */
  interrupt() {
    this.cancelled = true
    if (this.status === 'busy') this.kernel?.interrupt()
  }

  /** Empieza de cero: se pierde el espacio de nombres y todo vuelve a «nunca ejecutado». */
  restart() {
    this.cancelled = true
    this.kernel?.dispose()
    this.kernel = null
    this.records.clear()
    this.loops.clear()
    this.running = null
    this.status = 'stopped'
    this.problem = null
    this.notify({ type: 'views' })
  }

  dispose() {
    this.disposed = true
    this.kernel?.dispose()
    this.kernel = null
  }
}
