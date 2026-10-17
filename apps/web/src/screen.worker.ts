/// <reference lib="webworker" />
import screenSource from '../../../packages/extension/runtime/pantalla.py?raw'

/**
 * El programa **en marcha, para usarlo**: un segundo Python (Pyodide) en otro worker, aparte del que lo mira
 * línea a línea. Aquí el programa se ejecuta sin grabar nada y se queda vivo: lo que hace su `pantalla`
 * (sonar, un botón, dibujar) sale hacia la página, y cada pulsación vuelve y llama a su función.
 *
 * Peticiones: `{op: 'start', code}` (lo arranca de cero), `{op: 'press', id, args}` (una pulsación).
 * Eventos: `ready`, `screen` (una orden de la pantalla), `out` (lo que imprime), `error`, `idle` (terminó de
 * atender lo último), `fatal`.
 */

interface Pyodide {
  runPython(code: string): unknown
  globals: { get(name: string): unknown; set(name: string, value: unknown): void }
  FS: { writeFile(path: string, data: string): void }
  loadPackagesFromImports(code: string): Promise<unknown>
}

const PACKAGES = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/'

const scope = self as unknown as DedicatedWorkerGlobalScope
const post = (event: Record<string, unknown>) => scope.postMessage(event)

let ready: Promise<Pyodide> | null = null

async function boot(index: string): Promise<Pyodide> {
  const { loadPyodide } = (await import(/* @vite-ignore */ `${index}pyodide.mjs`)) as {
    loadPyodide(options: Record<string, unknown>): Promise<Pyodide>
  }
  const pyodide = await loadPyodide({ indexURL: index, packageBaseUrl: PACKAGES })
  pyodide.FS.writeFile('/home/pyodide/pantalla.py', screenSource)
  pyodide.globals.set('_app_screen', (text: string) => {
    post({ ev: 'screen', command: JSON.parse(text) as unknown })
  })
  pyodide.globals.set('_app_out', (text: string) => {
    post({ ev: 'out', text })
  })
  pyodide.globals.set('_app_error', (text: string) => {
    post({ ev: 'error', ...(JSON.parse(text) as Record<string, unknown>) })
  })
  pyodide.runPython(`
import io, json, os, sys, traceback
sys.path.insert(0, "/home/pyodide")
os.environ.pop("PRYSEL_SIMULAR", None)

class _AppOut:
    def write(self, text):
        if text:
            _app_out(text)
        return len(text)
    def flush(self):
        pass
    def isatty(self):
        return False

sys.stdout = sys.stderr = _AppOut()
sys.stdin = io.StringIO("")

def _app_report(caught):
    line = None
    for frame in traceback.extract_tb(caught.__traceback__):
        if frame.filename == "<programa>":
            line = frame.lineno
    if isinstance(caught, SyntaxError) and caught.filename == "<programa>":
        line = caught.lineno
    message = str(caught)
    if isinstance(caught, EOFError):
        message = "Con la pantalla, el programa no puede pedir datos con input(): usa botones o teclas."
    _app_error(json.dumps({"name": type(caught).__name__, "message": message[:300], "line": line}))

def _app_start(code):
    sys.modules.pop("pantalla", None)
    import pantalla
    pantalla._send = _app_screen
    namespace = {"__name__": "__main__"}
    globals()["_app_namespace"] = namespace
    try:
        exec(compile(code, "<programa>", "exec"), namespace)
    except BaseException as caught:
        _app_report(caught)

def _app_press(ident, args):
    import pantalla
    try:
        pantalla._dispatch(ident, *args)
    except BaseException as caught:
        _app_report(caught)
`)
  post({ ev: 'ready' })
  return pyodide
}

/** Las peticiones se atienden de una en una, en el orden en que llegan. */
let queue: Promise<void> = Promise.resolve()

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
      if (request['op'] === 'start') {
        const code = typeof request['code'] === 'string' ? request['code'] : ''
        try {
          await pyodide.loadPackagesFromImports(code)
        } catch {
          // Si no se pudo bajar, el import fallará al ejecutar y se verá como un error normal.
        }
        const start = pyodide.globals.get('_app_start') as (code: string) => void
        start(code)
      } else if (request['op'] === 'press') {
        const press = pyodide.globals.get('_app_press') as (id: number, args: unknown[]) => void
        const args = Array.isArray(request['args']) ? (request['args'] as unknown[]) : []
        press(Number(request['id']), args)
      }
      post({ ev: 'idle' })
    })
    .catch(() => undefined)
}
