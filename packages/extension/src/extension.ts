import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import * as vscode from 'vscode'
import { buildProgram, createPythonParser, type PythonParser } from '@prysel/python'
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
let panel: vscode.WebviewPanel | null = null
let currentDoc: vscode.TextDocument | null = null

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

function post(message: WebviewMessage) {
  panel?.webview.postMessage(message)
}

/** Analiza el documento activo y manda el programa al webview. */
function refresh() {
  if (!panel || !parser) return
  const doc = currentDoc
  if (!doc || doc.languageId !== 'python') {
    post({ type: 'update', program: null })
    return
  }
  try {
    const program = buildProgram(parser.parse(doc.getText()))
    post({ type: 'update', program, file: basename(doc.fileName) })
  } catch {
    // El código a medio escribir no debe tumbar el lienzo.
    post({ type: 'update', program: null })
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
  created.webview.onDidReceiveMessage((message) => {
    const parsed = parseHostMessage(message)
    if (!parsed) return
    // El webview está listo: mandar el tema y el estado actual.
    post({ type: 'theme', theme: themeKind() })
    refresh()
  })
  return created
}

export async function activate(context: vscode.ExtensionContext) {
  parser = await createPythonParser(wasmLocations())

  context.subscriptions.push(
    vscode.commands.registerCommand('prysel.openCanvas', async () => {
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
      post({ type: 'theme', theme: themeKind() })
      refresh()
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!panel || !currentDoc) return
      if (event.document.uri.toString() === currentDoc.uri.toString()) refresh()
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!panel) return
      currentDoc = editor?.document ?? null
      refresh()
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      post({ type: 'theme', theme: themeKind() })
    }),
  )
}

export function deactivate() {
  parser?.dispose()
  parser = null
}
