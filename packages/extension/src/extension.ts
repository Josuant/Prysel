import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import * as vscode from 'vscode'
import { buildProgram, createPythonParser, type PythonParser } from '@prysel/python'
import { validEdits, type TextEdit } from '@prysel/python/edits'
import { Kernel } from './kernel.ts'
import { parseHostMessage, type Theme, type WebviewMessage } from './protocol.ts'
import { Session } from './session.ts'

/**
 * Extensión de VS Code (cascarón, M0.5).
 *
 * Abre un webview con el mismo lienzo que la galería y convierte el archivo Python
 * activo en el diagrama, en tiempo real: cada cambio en el editor se reanaliza y se
 * reenvía. El parser corre en el host de la extensión; el webview solo dibuja.
 */

const require = createRequire(__filename)

/** El wasm de tree-sitter: la misma build que embarca VS Code. */
function wasmLocations(): { runtime: string; language: string } {
  const wasmDir = dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
  return { runtime: wasmDir, language: join(wasmDir, 'tree-sitter-python.wasm') }
}

let parser: PythonParser | null = null
let parserPromise: Promise<PythonParser> | null = null
let panel: vscode.WebviewPanel | null = null
let currentDoc: vscode.TextDocument | null = null

/** Todos los webviews abiertos (panel y vista de la barra): reciben el mismo estado. */
const webviews = new Set<vscode.Webview>()

/** Una sesión de ejecución por documento: cada archivo tiene su motor y su espacio de nombres. */
const sessions = new Map<string, Session>()

/**
 * El intérprete con el que se ejecuta: el de la configuración `prysel.python`, si se puso; si no, el
 * entorno que el usuario eligió para el archivo en la extensión de Python; y, en su defecto, `python`.
 */
async function pythonFor(doc: vscode.TextDocument): Promise<string> {
  const configured = vscode.workspace.getConfiguration('prysel').get<string>('python')
  if (configured) return configured
  try {
    const extension = vscode.extensions.getExtension('ms-python.python')
    const api = extension ? ((await extension.activate()) as PythonApi | undefined) : undefined
    const environments = api?.environments
    const path = environments?.getActiveEnvironmentPath?.(doc.uri)
    const resolved = path ? await environments?.resolveEnvironment?.(path) : undefined
    const executable = resolved?.executable?.uri?.fsPath ?? path?.path
    if (executable) return executable
  } catch {
    // Sin la extensión de Python (o con otra versión de su API): se usa el del PATH.
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** Lo poco que se usa de la API de la extensión de Python. */
interface PythonApi {
  environments?: {
    getActiveEnvironmentPath?: (resource?: vscode.Uri) => { path: string } | undefined
    resolveEnvironment?: (path: {
      path: string
    }) => Promise<{ executable?: { uri?: vscode.Uri } } | undefined>
  }
}

function sessionFor(doc: vscode.TextDocument): Session {
  const key = doc.uri.toString()
  let session = sessions.get(key)
  if (!session) {
    session = new Session(
      async () =>
        Kernel.start({
          python: await pythonFor(doc),
          cwd: vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? dirname(doc.uri.fsPath),
        }),
      (change) => {
        if (currentDoc?.uri.toString() !== key) return
        if (change.type === 'assets') {
          postToAll({ type: 'assets', seq: change.seq, assets: change.assets })
        } else {
          postRuns()
        }
      },
    )
    sessions.set(key, session)
  }
  return session
}

/** Cómo está cada sentencia del documento activo y el motor: el lienzo lo pinta sobre los nodos. */
function postRuns() {
  const doc = currentDoc
  if (!doc) return
  const session = sessions.get(doc.uri.toString())
  if (!session) return
  postToAll({
    type: 'runs',
    views: session.views(),
    kernel: session.status,
    problem: session.problem,
    version: doc.version,
  })
}

/** Ejecutar código es una acción que el usuario pide: en un espacio de trabajo sin confianza, no. */
function mayRun(): boolean {
  if (vscode.workspace.isTrusted) return true
  void vscode.window.showWarningMessage(
    'Prysel: ejecutar código exige confiar en este espacio de trabajo.',
  )
  return false
}

/** El parser se carga una sola vez y de forma perezosa: registrar comandos no debe esperarlo. */
function getParser(): Promise<PythonParser> {
  parserPromise ??= createPythonParser(wasmLocations()).then((created) => {
    parser = created
    return created
  })
  return parserPromise
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let nonce = ''
  for (let i = 0; i < 32; i++) nonce += alphabet[Math.floor(Math.random() * alphabet.length)]
  return nonce
}

function themeKind(): Theme {
  const kind = vscode.window.activeColorTheme.kind
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark'
}

function postToAll(message: WebviewMessage) {
  for (const webview of webviews) webview.postMessage(message)
}

/** Analiza el documento activo y manda el programa a todos los webviews. */
async function refresh() {
  if (webviews.size === 0) return
  currentDoc ??= vscode.window.activeTextEditor?.document ?? null
  const doc = currentDoc
  if (!doc || doc.languageId !== 'python') {
    postToAll({ type: 'update', program: null })
    return
  }
  try {
    const parser = await getParser()
    const text = doc.getText()
    const program = buildProgram(parser.parse(text), text)
    // Los resultados siguen a sus sentencias aunque el texto se haya movido.
    sessionFor(doc).update(program, text)
    postToAll({ type: 'update', program, file: basename(doc.fileName), version: doc.version })
    postRuns()
  } catch {
    // El código a medio escribir no debe tumbar el lienzo.
    postToAll({ type: 'update', program: null })
  }
}

function htmlFor(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce()
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'webview.js'),
  )
  const style = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'webview.css'),
  )
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ')
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${style}" />
    <title>Prysel</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" type="module" src="${script}"></script>
  </body>
</html>`
}

/**
 * Aplica al documento las ediciones que el usuario hizo en el lienzo. Los desplazamientos se
 * calcularon sobre una versión concreta del texto: si el documento ha cambiado desde entonces
 * (se tecleó en el editor mientras tanto), ya no valen y se descartan — y se reenvía el estado
 * para que el lienzo vuelva a mostrar lo que hay, en vez de quedarse con lo que el usuario creyó.
 */
async function applyEdits(edits: TextEdit[], version: number) {
  const doc = currentDoc
  if (!doc || doc.languageId !== 'python') return
  if (doc.version !== version || !validEdits(edits, doc.getText().length)) {
    void refresh()
    return
  }
  const change = new vscode.WorkspaceEdit()
  for (const edit of edits) {
    const range = new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end))
    change.replace(doc.uri, range, edit.text)
  }
  // El cambio dispara `onDidChangeTextDocument`, que reanaliza y reenvía el programa.
  if (!(await vscode.workspace.applyEdit(change))) void refresh()
}

/** Conecta un webview recién creado: responde al «ready» con el tema y el estado actual. */
function wireWebview(webview: vscode.Webview) {
  webview.onDidReceiveMessage((message) => {
    const parsed = parseHostMessage(message)
    if (!parsed) return
    if (parsed.type === 'edit') {
      void applyEdits(parsed.edits, parsed.version)
      return
    }
    if (parsed.type === 'run') {
      const doc = currentDoc
      if (!doc || doc.languageId !== 'python') return
      // Los ids llevan la línea: si el texto cambió desde que el lienzo los vio, no valen.
      if (doc.version !== parsed.version) return void refresh()
      if (mayRun()) void sessionFor(doc).run(parsed.ids)
      return
    }
    if (parsed.type === 'interrupt' || parsed.type === 'restart') {
      const session = currentDoc ? sessions.get(currentDoc.uri.toString()) : undefined
      if (parsed.type === 'interrupt') session?.interrupt()
      else session?.restart()
      return
    }
    postToAll({ type: 'theme', theme: themeKind() })
    void refresh().then(() => {
      // Un lienzo recién abierto no tiene las imágenes de lo que ya se ejecutó: se le mandan.
      const session = currentDoc ? sessions.get(currentDoc.uri.toString()) : undefined
      for (const { seq, assets } of session?.allAssets() ?? []) {
        postToAll({ type: 'assets', seq, assets })
      }
    })
  })
}

function createPanel(extensionUri: vscode.Uri): vscode.WebviewPanel {
  const created = vscode.window.createWebviewPanel(
    'prysel.canvas',
    'Prysel — lienzo',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    },
  )
  created.webview.html = htmlFor(created.webview, extensionUri)
  webviews.add(created.webview)
  wireWebview(created.webview)
  created.onDidDispose(() => {
    webviews.delete(created.webview)
  })
  return created
}

/** El mismo lienzo, como vista de la barra de actividad. */
class CanvasViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'prysel.canvasView'

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    }
    webviewView.webview.html = htmlFor(webviewView.webview, this.extensionUri)
    webviews.add(webviewView.webview)
    wireWebview(webviewView.webview)
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) return
      postToAll({ type: 'theme', theme: themeKind() })
      void refresh()
    })
    webviewView.onDidDispose(() => {
      webviews.delete(webviewView.webview)
    })
  }
}

export function activate(context: vscode.ExtensionContext) {
  // El comando y la vista se registran de forma síncrona: el parser se carga aparte.
  context.subscriptions.push(
    vscode.commands.registerCommand('prysel.openCanvas', async () => {
      try {
        await getParser()
      } catch (error) {
        vscode.window.showErrorMessage(`Prysel: no se pudo cargar el parser. ${messageOf(error)}`)
        return
      }
      if (!panel) {
        panel = createPanel(context.extensionUri)
        panel.onDidDispose(() => {
          panel = null
          currentDoc = null
        })
      } else {
        panel.reveal(vscode.ViewColumn.Beside)
      }
      currentDoc = vscode.window.activeTextEditor?.document ?? null
      postToAll({ type: 'theme', theme: themeKind() })
      void refresh()
    }),
    vscode.window.registerWebviewViewProvider(
      CanvasViewProvider.viewType,
      new CanvasViewProvider(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString()
      sessions.get(key)?.dispose()
      sessions.delete(key)
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!currentDoc) return
      if (event.document.uri.toString() === currentDoc.uri.toString()) void refresh()
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      currentDoc = editor?.document ?? null
      void refresh()
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      postToAll({ type: 'theme', theme: themeKind() })
    }),
  )
}

export function deactivate() {
  for (const session of sessions.values()) session.dispose()
  sessions.clear()
  parser?.dispose()
  parser = null
}
