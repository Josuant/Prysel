import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import * as vscode from 'vscode'
import { buildProgram, createPythonParser, type PythonParser } from '@prysel/python'
import { validEdits, type TextEdit } from '@prysel/python/edits'
import { anthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './ai/anthropic.ts'
import { generateLesson } from './ai/generate.ts'
import type { AiProvider } from './ai/provider.ts'
import { vscodeLmProvider } from './ai/vscodeLm.ts'
import { Kernel } from './kernel.ts'
import { lessonFileFor, readLesson, skeletonLesson } from './lesson.ts'
import { parseHostMessage, type Theme, type WebviewMessage } from './protocol.ts'
import { Session } from './session.ts'
import type { KernelStatus, RunState } from './runs.ts'

/**
 * Extensión de VS Code (cascarón, M0.5).
 *
 * Abre un webview con el mismo lienzo que la galería y convierte el archivo Python
 * activo en el diagrama, en tiempo real: cada cambio en el editor se reanaliza y se
 * reenvía. El parser corre en el host de la extensión; el webview solo dibuja.
 */

const require = createRequire(__filename)

/**
 * El wasm de tree-sitter: la misma build que embarca VS Code. Empaquetada, junto al código compilado
 * (`dist/wasm`); en desarrollo y en las pruebas, en `node_modules`.
 */
function wasmLocations(): { runtime: string; language: string } {
  const bundled = join(__dirname, 'wasm')
  const wasmDir = existsSync(join(bundled, 'tree-sitter.wasm'))
    ? bundled
    : dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
  return { runtime: wasmDir, language: join(wasmDir, 'tree-sitter-python.wasm') }
}

let parser: PythonParser | null = null
let parserPromise: Promise<PythonParser> | null = null
/** Por qué no se pudo cargar el parser la última vez, si no se pudo. */
let parserError: string | null = null
let panel: vscode.WebviewPanel | null = null
let currentDoc: vscode.TextDocument | null = null

/** Cuántas veces un webview avisó de que ya cargó (`ready`): es lo que dice que su página arrancó de verdad. */
let webviewsReady = 0

/** Cómo fue la última grabación de una traza: para las pruebas y para entender qué pasó. */
let lastTrace: { status: 'running' | 'done' | 'failed'; steps: number; version: number } | null =
  null

/** La lección que se mandó al lienzo la última vez (o por qué no se pudo leer): para las pruebas. */
let lastLesson: { title: string; beats: number; error: string | null } | null = null

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
  parserPromise ??= createPythonParser(wasmLocations()).then(
    (created) => {
      parser = created
      parserError = null
      return created
    },
    (error: unknown) => {
      // Un fallo no se recuerda para siempre: la próxima petición lo vuelve a intentar.
      parserPromise = null
      parserError = messageOf(error)
      throw error
    },
  )
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
  if (message.type === 'trace') {
    lastTrace = {
      status: message.status,
      steps: message.trace?.events.length ?? 0,
      version: message.version,
    }
  }
  if (message.type === 'lesson') {
    lastLesson = message.lesson
      ? { title: message.lesson.title, beats: message.lesson.beats.length, error: null }
      : message.error
        ? { title: '', beats: 0, error: message.error }
        : null
  }
  for (const webview of webviews) webview.postMessage(message)
}

/** Analiza un documento y deja su sesión de ejecución al día con lo que hay escrito. */
async function analyse(doc: vscode.TextDocument) {
  const parser = await getParser()
  const text = doc.getText()
  const program = buildProgram(parser.parse(text), text)
  // Los resultados siguen a sus sentencias aunque el texto se haya movido.
  sessionFor(doc).update(program, text)
  return program
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
    const program = await analyse(doc)
    postToAll({ type: 'update', program, file: basename(doc.fileName), version: doc.version })
    postRuns()
    void postLesson(doc)
  } catch {
    // El código a medio escribir no debe tumbar el lienzo.
    postToAll({ type: 'update', program: null })
  }
}

/** Dónde vive, en el llavero del sistema, la clave de la API de Anthropic. */
const ANTHROPIC_SECRET = 'prysel.anthropicApiKey'

/**
 * El proveedor de IA con el que generar una lección: el que se pida en el ajuste `prysel.aiProvider`, o
 * («auto», por defecto) el de `vscode.lm` si hay uno instalado y, si no, el de Anthropic si hay clave.
 * `null` si no hay ninguno disponible.
 */
async function pickProvider(context: vscode.ExtensionContext): Promise<AiProvider | null> {
  const preference = vscode.workspace.getConfiguration('prysel').get<string>('aiProvider') ?? 'auto'
  const tryVscode = async () => {
    try {
      return await vscodeLmProvider()
    } catch {
      return null
    }
  }
  const tryAnthropic = async () => {
    const key = await context.secrets.get(ANTHROPIC_SECRET)
    if (!key) return null
    const model = vscode.workspace.getConfiguration('prysel').get<string>('anthropicModel')
    return anthropicProvider({ apiKey: key, model: model || DEFAULT_ANTHROPIC_MODEL })
  }
  if (preference === 'vscode') return tryVscode()
  if (preference === 'anthropic') return tryAnthropic()
  return (await tryVscode()) ?? (await tryAnthropic())
}

/**
 * Genera el guion de la lección de un archivo con IA: se traza el programa (la verdad sobre la que se
 * narra) y se le pide al modelo que lo explique anclado a esa traza, validando y reparando lo que haga
 * falta. El código y la traza salen de la máquina del usuario: se avisa antes de mandarlos.
 */
async function explainFile(context: vscode.ExtensionContext, doc: vscode.TextDocument) {
  const provider = await pickProvider(context)
  if (!provider) {
    void vscode.window.showInformationMessage(
      'Prysel: no hay ningún proveedor de IA disponible. Instala una extensión de chat (como Copilot) ' +
        'o configura una clave con «Prysel: Configurar la clave de Anthropic».',
    )
    return
  }
  const lessonUri = lessonUriOf(doc)
  try {
    await vscode.workspace.fs.stat(lessonUri)
    const overwrite = await vscode.window.showWarningMessage(
      `Prysel: «${basename(lessonUri.fsPath)}» ya existe. ¿Generarla de nuevo y sobrescribirla?`,
      { modal: true },
      'Generar de nuevo',
    )
    if (overwrite !== 'Generar de nuevo') return
  } catch {
    // No existe: se crea sin preguntar.
  }
  const proceed = await vscode.window.showWarningMessage(
    `Prysel enviará el código de «${basename(doc.fileName)}» y la traza de ejecutarlo a ${provider.id} ` +
      'para generar la lección. ¿Continuar?',
    { modal: true },
    'Continuar',
  )
  if (proceed !== 'Continuar') return

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Prysel: generando con ${provider.id}…`,
    },
    async () => {
      let program
      try {
        program = await analyse(doc)
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Prysel: no se pudo analizar el archivo. ${messageOf(error)}`,
        )
        return
      }
      const trace = await sessionFor(doc).trace(doc.getText())
      if (!trace) {
        const problem = sessions.get(doc.uri.toString())?.problem ?? 'motivo desconocido'
        void vscode.window.showErrorMessage(`Prysel: no se pudo grabar la traza (${problem}).`)
        return
      }
      const result = await generateLesson(program, trace, provider, {
        source: basename(doc.fileName),
        lang: 'es',
      })
      if (!result.ok || !result.lesson) {
        void vscode.window.showErrorMessage(
          `Prysel: la lección no pasó la validación tras ${result.attempts} intento(s). ${result.error ?? ''}`,
        )
        return
      }
      await vscode.workspace.fs.writeFile(
        lessonUri,
        Buffer.from(JSON.stringify(result.lesson, null, 2) + '\n', 'utf8'),
      )
      await postLesson(doc)
      void vscode.window.showInformationMessage(
        `Prysel: lección generada (${result.attempts} intento${result.attempts === 1 ? '' : 's'}).`,
      )
    },
  )
}

/** El guion de la lección de un archivo: el `.lesson.json` que hay junto a él (`factorial.py` → `factorial.lesson.json`). */
const isLessonFile = (doc: vscode.TextDocument) => doc.fileName.endsWith('.lesson.json')
const lessonUriOf = (doc: vscode.TextDocument) => vscode.Uri.file(lessonFileFor(doc.fileName))

/**
 * Lee el guion del archivo que se enseña y se lo manda al lienzo. Si el guion está abierto en un editor se
 * lee de ahí (lo que se está escribiendo, aún sin guardar); si no, del disco. Sin guion, se manda `null`.
 */
async function postLesson(doc: vscode.TextDocument) {
  const file = basename(doc.fileName)
  if (doc.uri.scheme !== 'file') return postToAll({ type: 'lesson', file, lesson: null })
  const uri = lessonUriOf(doc)
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
  let raw: string | null = open ? open.getText() : null
  if (raw === null) {
    try {
      raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
    } catch {
      raw = null
    }
  }
  if (raw === null) return postToAll({ type: 'lesson', file, lesson: null })
  const result = readLesson(raw)
  postToAll(
    result.ok
      ? { type: 'lesson', file, lesson: result.lesson }
      : { type: 'lesson', file, lesson: null, error: result.error },
  )
}

/** Crea el guion de partida del archivo (si no lo tiene) y lo abre para escribirlo. */
async function openLesson(doc: vscode.TextDocument) {
  const uri = lessonUriOf(doc)
  try {
    await vscode.workspace.fs.stat(uri)
  } catch {
    const program = await analyse(doc)
    const statements = program.nodes
      .filter((node) => node.range && node.range.owner === undefined && node.text)
      .map((node) => (node.text ?? '').split(/\r?\n/)[0]?.trim() ?? '')
      .filter((text) => text !== '')
    const text = skeletonLesson(basename(doc.fileName), statements)
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'))
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: false,
  })
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

/** Graba la traza del archivo entero y se la manda al lienzo (con la versión del texto que se trazó). */
async function traceDocument(doc: vscode.TextDocument) {
  const version = doc.version
  const text = doc.getText()
  postToAll({ type: 'trace', version, status: 'running', trace: null })
  const trace = await sessionFor(doc).trace(text)
  if (trace) postToAll({ type: 'trace', version, status: 'done', trace })
  else {
    const problem = sessions.get(doc.uri.toString())?.problem ?? 'No se pudo grabar la traza.'
    postToAll({ type: 'trace', version, status: 'failed', trace: null, message: problem })
  }
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
    if (parsed.type === 'newLesson') {
      void vscode.commands.executeCommand('prysel.newLesson')
      return
    }
    if (parsed.type === 'trace') {
      const doc = currentDoc
      if (!doc || doc.languageId !== 'python') return
      if (doc.version !== parsed.version) return void refresh()
      if (mayRun()) void traceDocument(doc)
      return
    }
    if (parsed.type === 'interrupt' || parsed.type === 'restart') {
      const session = currentDoc ? sessions.get(currentDoc.uri.toString()) : undefined
      if (parsed.type === 'interrupt') session?.interrupt()
      else session?.restart()
      return
    }
    webviewsReady++
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

/**
 * Lo que la extensión ofrece a otras extensiones y a las pruebas: cómo está la sesión de ejecución de un
 * documento (el activo, si no se dice).
 */
export interface PryselApi {
  state(uri?: vscode.Uri): {
    /** El parser de Python: cargado, pendiente o con el motivo por el que no cargó. */
    parser: string
    kernel: KernelStatus
    problem: string | null
    /** El estado de cada sentencia de primer nivel, en el orden del archivo. */
    states: RunState[]
    /** Lo que imprimieron las sentencias, junto. */
    stdout: string
    /** Cuántas veces un webview avisó de que cargó. */
    webviewsReady: number
    /** El documento que se está enseñando y los que tienen una sesión (para entender qué pasa). */
    document: string | null
    sessions: string[]
    /** La última traza que se grabó, si se grabó alguna. */
    trace: { status: 'running' | 'done' | 'failed'; steps: number; version: number } | null
    /** La última lección que se mandó al lienzo, si la hay. */
    lesson: { title: string; beats: number; error: string | null } | null
  }
}

/** El documento sobre el que actúan los comandos de ejecución: el activo, si es Python. */
function targetDocument(): vscode.TextDocument | null {
  const doc = vscode.window.activeTextEditor?.document ?? currentDoc
  return doc?.languageId === 'python' ? doc : null
}

export function activate(context: vscode.ExtensionContext): PryselApi {
  // El comando y la vista se registran de forma síncrona: el parser se carga aparte.
  context.subscriptions.push(
    vscode.commands.registerCommand('prysel.runAll', async () => {
      const doc = targetDocument()
      if (!doc) {
        void vscode.window.showInformationMessage(
          'Prysel: abre un archivo de Python para ejecutarlo.',
        )
        return
      }
      if (!mayRun()) return
      try {
        await analyse(doc)
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Prysel: no se pudo analizar el archivo. ${messageOf(error)}`,
        )
        return
      }
      await sessionFor(doc).run('all')
    }),
    vscode.commands.registerCommand('prysel.trace', async () => {
      const doc = targetDocument()
      if (!doc) {
        void vscode.window.showInformationMessage(
          'Prysel: abre un archivo de Python para trazarlo.',
        )
        return
      }
      if (!mayRun()) return
      // La traza se enseña en el lienzo: se abre si no lo estaba.
      await vscode.commands.executeCommand('prysel.openCanvas')
      await traceDocument(doc)
    }),
    vscode.commands.registerCommand('prysel.newLesson', async () => {
      const doc = targetDocument()
      if (!doc || doc.uri.scheme !== 'file') {
        void vscode.window.showInformationMessage(
          'Prysel: abre un archivo de Python guardado para escribir su lección.',
        )
        return
      }
      try {
        await openLesson(doc)
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Prysel: no se pudo abrir la lección. ${messageOf(error)}`,
        )
      }
    }),
    vscode.commands.registerCommand('prysel.showAiProvider', async () => {
      const provider = await pickProvider(context)
      void vscode.window.showInformationMessage(
        provider
          ? `Prysel: se usaría «${provider.id}» para generar una lección.`
          : 'Prysel: ningún proveedor disponible. Instala una extensión de chat (Copilot u otra) o ' +
              'configura una clave con «Prysel: Configurar la clave de Anthropic».',
      )
    }),
    vscode.commands.registerCommand('prysel.explainFile', async () => {
      const doc = targetDocument()
      if (!doc || doc.uri.scheme !== 'file') {
        void vscode.window.showInformationMessage(
          'Prysel: abre un archivo de Python guardado para explicarlo con IA.',
        )
        return
      }
      if (!mayRun()) return
      try {
        await explainFile(context, doc)
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Prysel: no se pudo generar la lección. ${messageOf(error)}`,
        )
      }
    }),
    vscode.commands.registerCommand('prysel.setAnthropicKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Clave de la API de Anthropic (console.anthropic.com)',
        password: true,
        ignoreFocusOut: true,
      })
      if (!key) return
      await context.secrets.store(ANTHROPIC_SECRET, key)
      void vscode.window.showInformationMessage('Prysel: clave de Anthropic guardada.')
    }),
    vscode.commands.registerCommand('prysel.clearAnthropicKey', async () => {
      await context.secrets.delete(ANTHROPIC_SECRET)
      void vscode.window.showInformationMessage('Prysel: clave de Anthropic borrada.')
    }),
    vscode.commands.registerCommand('prysel.interrupt', () => {
      const doc = targetDocument()
      if (doc) sessions.get(doc.uri.toString())?.interrupt()
    }),
    vscode.commands.registerCommand('prysel.restart', () => {
      const doc = targetDocument()
      if (doc) sessions.get(doc.uri.toString())?.restart()
    }),
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
      // Lo que se enseñaba se cerró: se pasa a lo que haya abierto, o al lienzo vacío.
      if (currentDoc?.uri.toString() === key) {
        currentDoc = null
        void refresh()
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!currentDoc) return
      if (event.document.uri.toString() === currentDoc.uri.toString()) void refresh()
      // El guion se está escribiendo: el lienzo lo sigue sin esperar a guardarlo.
      else if (
        isLessonFile(event.document) &&
        event.document.uri.toString() === lessonUriOf(currentDoc).toString()
      ) {
        void postLesson(currentDoc)
      }
    }),
    (() => {
      // Crear, guardar o borrar el guion desde fuera del editor (otro programa, git, la IA).
      const watcher = vscode.workspace.createFileSystemWatcher('**/*.lesson.json')
      const changed = () => {
        if (currentDoc?.languageId === 'python') void postLesson(currentDoc)
      }
      watcher.onDidChange(changed)
      watcher.onDidCreate(changed)
      watcher.onDidDelete(changed)
      return watcher
    })(),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      // Sin editor de texto (el foco pasó al propio lienzo, o a otro panel) se sigue enseñando el mismo
      // documento: si no, el diagrama se vaciaría justo al pulsar sobre él.
      if (!editor) return
      // Escribir el guion no cambia lo que se enseña: sigue el programa al que pertenece.
      if (isLessonFile(editor.document)) return
      currentDoc = editor.document
      void refresh()
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      postToAll({ type: 'theme', theme: themeKind() })
    }),
  )
  return {
    state(uri) {
      const key = (uri ?? targetDocument()?.uri)?.toString()
      const session = key === undefined ? undefined : sessions.get(key)
      const views = session ? Object.values(session.views()) : []
      return {
        parser: parser ? 'cargado' : parserError ? `falló: ${parserError}` : 'pendiente',
        kernel: session?.status ?? 'stopped',
        problem: session?.problem ?? null,
        states: views.map((view) => view.state),
        stdout: views.map((view) => view.stdout ?? '').join(''),
        webviewsReady,
        document: currentDoc?.uri.toString() ?? null,
        sessions: [...sessions.keys()],
        trace: lastTrace,
        lesson: lastLesson,
      }
    },
  }
}

export function deactivate() {
  for (const session of sessions.values()) session.dispose()
  sessions.clear()
  parser?.dispose()
  parser = null
}
