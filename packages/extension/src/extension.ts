import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import * as vscode from 'vscode'
import { buildProgram, createPythonParser, type PythonParser } from '@prysel/python'
import { validEdits, type TextEdit } from '@prysel/python/edits'
import { parseHostMessage, type Theme, type WebviewMessage } from './protocol.ts'

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
    postToAll({ type: 'update', program, file: basename(doc.fileName), version: doc.version })
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
    postToAll({ type: 'theme', theme: themeKind() })
    void refresh()
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
  parser?.dispose()
  parser = null
}
