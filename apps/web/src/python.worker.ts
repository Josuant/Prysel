/// <reference lib="webworker" />
import runnerSource from '../../../packages/extension/runtime/prysel_runner.py?raw'

/**
 * El motor de ejecución de la web: el mismo `prysel_runner.py` de la extensión, pero dentro de Pyodide
 * (Python compilado a WebAssembly) en un worker, para que un bucle largo no congele la página.
 *
 * Habla el mismo protocolo que en VS Code (peticiones `{op, …}` y eventos `{ev, …}`), solo que por
 * `postMessage` en vez de por un socket: el runner escribe en un «canal» que reenvía cada línea aquí.
 * Cortar un programa en marcha es terminar el worker (no hay hilos en Pyodide): quien lo usa arranca otro.
 */

/** La versión de la CDN de la que se bajan los paquetes (numpy, pandas…): la misma del núcleo. */
const PACKAGES = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/'

interface Pyodide {
  runPython(code: string): unknown
  globals: { get(name: string): unknown; set(name: string, value: unknown): void }
  FS: { writeFile(path: string, data: string): void }
  loadPackagesFromImports(code: string): Promise<unknown>
}

const scope = self as unknown as DedicatedWorkerGlobalScope
const post = (event: Record<string, unknown>) => scope.postMessage(event)

let ready: Promise<Pyodide> | null = null

/** `index`: de dónde se carga el núcleo de Pyodide (lo dice la página: el worker no sabe dónde vive ella). */
async function boot(index: string): Promise<Pyodide> {
  const { loadPyodide } = (await import(/* @vite-ignore */ `${index}pyodide.mjs`)) as {
    loadPyodide(options: Record<string, unknown>): Promise<Pyodide>
  }
  const pyodide = await loadPyodide({ indexURL: index, packageBaseUrl: PACKAGES })
  pyodide.FS.writeFile('/home/pyodide/prysel_runner.py', runnerSource)
  pyodide.globals.set('_prysel_send', (line: string) => {
    for (const part of line.split('\n')) {
      if (part.trim()) post(JSON.parse(part) as Record<string, unknown>)
    }
  })
  pyodide.runPython(`
import io, sys
sys.path.insert(0, "/home/pyodide")
import prysel_runner as _pr

class _Channel:
    def sendall(self, data):
        _prysel_send(data.decode("utf-8"))

_pr._channel = _Channel()
sys.stdin = io.StringIO("")
_runner = _pr.Runner()

def _prysel_handle(raw):
    global _runner
    import json
    request = json.loads(raw)
    op = request.get("op")
    if op == "run":
        _runner.run(request)
    elif op == "trace":
        _runner.trace(request)
    elif op == "reset":
        _runner = _pr.Runner()
        _pr.emit({"ev": "reset"})
    elif op == "vars":
        names = {
            n: _pr.summarize(v)
            for n, v in _runner.namespace.items()
            if not n.startswith("_") and type(v).__name__ != "module"
        }
        _pr.emit({"ev": "vars", "id": request.get("id"), "vars": names})
`)
  const version = String(pyodide.runPython('import sys; sys.version.split()[0]'))
  post({ ev: 'ready', python: version, cwd: '/home/pyodide', pid: 0 })
  return pyodide
}

/** Las peticiones se atienden de una en una, en el orden en que llegan. */
let queue: Promise<void> = Promise.resolve()
let handle: ((raw: string) => void) | null = null

scope.onmessage = (message: MessageEvent<Record<string, unknown>>) => {
  const request = message.data
  const booting = (ready ??= boot(String(request['index'] ?? '')).catch((error: unknown) => {
    post({ ev: 'fatal', message: error instanceof Error ? error.message : String(error) })
    throw error
  }))
  if (request['op'] === 'boot') return
  queue = queue
    .then(async () => {
      const pyodide = await booting
      const code = typeof request['code'] === 'string' ? request['code'] : ''
      if (code) {
        try {
          // Lo que el programa importa y Pyodide trae aparte (numpy, pandas, matplotlib…) se baja antes.
          await pyodide.loadPackagesFromImports(code)
        } catch {
          // Si no se pudo bajar, el import fallará al ejecutar y se verá como un error normal.
        }
      }
      handle ??= pyodide.globals.get('_prysel_handle') as (raw: string) => void
      handle(JSON.stringify(request))
    })
    .catch(() => undefined)
}
