import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import * as vscode from 'vscode'
import { buildProgram, createPythonParser, type PythonParser } from '@prysel/python'
import { sectionInserts, validEdits, type TextEdit } from '@prysel/python/edits'
import { anthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './ai/anthropic.ts'
import { cacheKeyOf, type CachedTopic } from './ai/cache.ts'
import { generateLesson } from './ai/generate.ts'
import { proposeSections, sectionBlocks } from './ai/sections.ts'
import type { AiProvider } from './ai/provider.ts'
import {
  generateTopic,
  TOPIC_TRACE_LIMIT,
  type TopicOptions,
  type TopicRuntime,
} from './ai/topic.ts'
import { vscodeLmProvider } from './ai/vscodeLm.ts'
import { EditHistory } from './history.ts'
import { Kernel } from './kernel.ts'
import {
  lessonFileFor,
  moveNoteIn,
  parseLesson,
  readLesson,
  skeletonLesson,
  type Lesson,
} from './lesson.ts'
import {
  MAX_COMMAND,
  parseHostMessage,
  type CommandMessage,
  type Theme,
  type WebviewMessage,
} from './protocol.ts'
import {
  applyEdits as applyTextEdits,
  clearGenerating,
  fillGenerated,
  untouchedTemplate,
} from '@prysel/python/edits'
import type { TemplateId } from '@prysel/morphology'
import { DEFAULT_JEV_MODEL, JevError, typesafeDecider, type Decider } from './jev/client.ts'
import { CallLog } from './calls.ts'
import { smartAsk } from './jev/ask.ts'
import { splitOrder } from './jev/compose.ts'
import { contextFor } from './jev/context.ts'
import {
  judgeArchitecture,
  judgeConfig,
  judgeCover,
  judgeInterruption,
  type Flavour,
  type Interruption,
} from './jev/plain.ts'
import { Gists } from './gists.ts'
import { build, modify, summaryOf, type Outcome, type Stagehand } from './jev/director.ts'
import { decideCommand, type Directive, type Effect } from './jev/engine.ts'
import { deepseekProvider, DEEPSEEK_MODELS, DEFAULT_DEEPSEEK_MODEL } from './ai/deepseek.ts'
import { explainNode, generateFill } from './jev/fill.ts'
import { localDecider } from './jev/local.ts'
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
 * entorno que el usuario eligió para ese archivo en la extensión de Python; y, en su defecto, `python`.
 * Toma un `Uri` (no un documento) porque «Explicar un tema» necesita resolverlo antes de que el archivo
 * exista.
 */
async function pythonFor(uri: vscode.Uri): Promise<string> {
  const configured = vscode.workspace.getConfiguration('prysel').get<string>('python')
  if (configured) return configured
  try {
    const extension = vscode.extensions.getExtension('ms-python.python')
    const api = extension ? ((await extension.activate()) as PythonApi | undefined) : undefined
    const environments = api?.environments
    const path = environments?.getActiveEnvironmentPath?.(uri)
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
          python: await pythonFor(doc.uri),
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

/** Lo último que se le dijo al lienzo (las decisiones y lo que se dice): para las pruebas. */
const saidLog: string[] = []
/** Y lo último que llegó de él (su tipo): para las pruebas. */
const heardLog: string[] = []

function postToAll(message: WebviewMessage) {
  if (message.type === 'decision') {
    const { directive } = message
    saidLog.push(
      `${directive.kind}: ${'say' in directive ? directive.say : 'question' in directive ? directive.question : ''}`,
    )
  } else if (message.type === 'say') saidLog.push(`say: ${message.text}`)
  if (saidLog.length > 20) saidLog.splice(0, saidLog.length - 20)
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
    // Cuando el código se asiente, se mira (si no ha cambiado desde la última vez, no hace nada).
    gistsFor(doc).touch()
    postRuns()
    postHistory(doc)
    void postLesson(doc)
    tendGenerating(doc, program)
  } catch {
    // El código a medio escribir no debe tumbar el lienzo.
    postToAll({ type: 'update', program: null })
  }
}

/**
 * Lo que se le pregunta a cada modelo y lo que contesta: el lienzo lo enseña en su pestaña «Consultas».
 * Cada cambio (una consulta que empieza, avanza o acaba) se le manda en cuanto pasa.
 */
const callLog = new CallLog((entry) => {
  postToAll({ type: 'call', entry })
})

// ───────────────────────── «qué hace», cómo le fue y cómo avanza ─────────────────────────

/**
 * La IA y el JEV con los que se miran los programas (las tarjetas «Qué hace», el visor de cómo avanza…): se
 * eligen como en las órdenes y se recuerdan aquí, porque se consultan a menudo y sin esperar.
 */
let gistProvider: AiProvider | null = null
let gistDecider: Decider | null = null
/** Lo que se mira de cada documento: el mismo motor que la web (`gists.ts`), con su propia memoria. */
const gistHosts = new Map<string, Gists>()

/**
 * El motor que mira un documento: lo ejecuta aparte cuando el código se asienta, saca de la traza lo que
 * hace cada función, cómo le fue al programa y cómo avanza, y se lo manda al lienzo.
 *
 * En VS Code el programa corre en el equipo de verdad (no en un navegador): solo se ejecuta solo en un
 * espacio de trabajo de confianza y en **modo seguro** (módulos que no tocan nada: `random`, `math`…). Lo
 * que no lo cumple se dice, y lo ejecuta quien lo usa.
 */
function gistsFor(doc: vscode.TextDocument): Gists {
  const key = doc.uri.toString()
  const known = gistHosts.get(key)
  if (known) return known
  const host = new Gists({
    version: () => doc.version,
    text: () => doc.getText(),
    analyse: () => analyse(doc),
    trace: async (code, inputs, seed = 7, watch) => {
      if (!vscode.workspace.isTrusted) return null
      // Un programa largo no se corta al llegar al tope: deja de grabarse y acaba, para ver qué da.
      return sessionFor(doc).trace(code, 20_000, true, true, {
        seed,
        finish: true,
        ...(inputs ? { inputs } : {}),
        ...(watch ? { watch } : {}),
      })
    },
    provider: () => gistProvider,
    decider: () => gistDecider ?? callLog.decider(localDecider()),
    busy: () => building.has(key),
    post: (gists, version, run) => {
      // El lienzo ya enseña otro archivo: esto no le dice nada.
      if (currentDoc?.uri.toString() !== key) return
      postToAll({ type: 'gists', version, gists, ...(run ? { run } : {}) })
    },
  })
  gistHosts.set(key, host)
  return host
}

/** Qué pieza cubre cada parte de lo pedido: una respuesta que llega tarde (a otra pregunta) no vale. */
const coverTurns = { written: 0, planned: 0 }

/** Por cada documento, cuánto había en su historia de deshacer al empezar cada orden («no, eso no»). */
const orderMarks = new Map<string, number[]>()

/** La versión con la que se rehace lo que se pidió (una de las propuestas): la toma la construcción. */
let remaking: Flavour | null = null

/** Dónde vive, en el llavero del sistema, la clave de la API de Anthropic. */
const ANTHROPIC_SECRET = 'prysel.anthropicApiKey'
/** Y la de DeepSeek. */
const DEEPSEEK_SECRET = 'prysel.deepseekApiKey'

/**
 * El proveedor de IA con el que generar una lección: el que se pida en el ajuste `prysel.aiProvider`, o
 * («auto», por defecto) el de `vscode.lm` si hay uno instalado y, si no, el de Anthropic si hay clave.
 * `null` si no hay ninguno disponible.
 */
async function pickProvider(context: vscode.ExtensionContext): Promise<AiProvider | null> {
  const preference = vscode.workspace.getConfiguration('prysel').get<string>('aiProvider') ?? 'auto'
  const tryVscode = async () => {
    try {
      return await vscodeLmProvider(
        vscode.workspace.getConfiguration('prysel').get<string>('vscodeModel') || undefined,
      )
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
  const tryDeepseek = async () => {
    const key = await context.secrets.get(DEEPSEEK_SECRET)
    if (!key) return null
    const settings = vscode.workspace.getConfiguration('prysel')
    return deepseekProvider({
      apiKey: key,
      model: settings.get<string>('deepseekModel') || DEFAULT_DEEPSEEK_MODEL,
      thinking: settings.get<boolean>('deepseekThinking') === true,
    })
  }
  const chosen =
    preference === 'vscode'
      ? await tryVscode()
      : preference === 'anthropic'
        ? await tryAnthropic()
        : preference === 'deepseek'
          ? await tryDeepseek()
          : ((await tryVscode()) ?? (await tryAnthropic()) ?? (await tryDeepseek()))
  // Cada petición que se le haga queda apuntada, para verla en la pestaña «Consultas».
  return chosen ? callLog.provider(chosen) : null
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

/**
 * La IA propone las **etapas** de los bloques largos que no las tienen (dónde empieza cada fase y cómo se
 * llama). Lo que propone no se escribe solo: llega como una edición que el usuario revisa en la vista
 * previa de refactorización de VS Code y acepta o descarta. El código sale de la máquina: se avisa antes.
 */
async function proposeFileSections(context: vscode.ExtensionContext, doc: vscode.TextDocument) {
  let program
  try {
    program = await analyse(doc)
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Prysel: no se pudo analizar el archivo. ${messageOf(error)}`,
    )
    return
  }
  if (sectionBlocks(program).length === 0) {
    void vscode.window.showInformationMessage(
      'Prysel: no hay bloques largos sin etapas. Cada bloque de más de tres sentencias ya tiene las suyas.',
    )
    return
  }
  const provider = await pickProvider(context)
  if (!provider) {
    void vscode.window.showInformationMessage(
      'Prysel: no hay ningún proveedor de IA disponible. Instala una extensión de chat (como Copilot) ' +
        'o configura una clave con «Prysel: Configurar la clave de Anthropic».',
    )
    return
  }
  const proceed = await vscode.window.showWarningMessage(
    `Prysel enviará el código de «${basename(doc.fileName)}» a ${provider.id} para proponer sus etapas. ` +
      'Podrás revisar cada comentario antes de que se escriba. ¿Continuar?',
    { modal: true },
    'Continuar',
  )
  if (proceed !== 'Continuar') return
  const version = doc.version
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Prysel: proponiendo etapas con ${provider.id}…`,
    },
    () => proposeSections(program, provider, 'es'),
  )
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      `Prysel: las etapas no pasaron la validación tras ${result.attempts} intento(s). ${result.error}`,
    )
    return
  }
  if (doc.version !== version) {
    void vscode.window.showWarningMessage(
      'Prysel: el archivo cambió mientras se proponían las etapas. Vuelve a pedirlas.',
    )
    return
  }
  const edit = new vscode.WorkspaceEdit()
  for (const insert of sectionInserts(program, result.sections)) {
    const title = result.sections.find((section) =>
      insert.text.includes(`# ${section.title}`),
    )?.title
    edit.insert(doc.uri, doc.positionAt(insert.start), insert.text, {
      needsConfirmation: true,
      label: 'Etapa propuesta por la IA',
      ...(title ? { description: title } : {}),
    })
  }
  await vscode.workspace.applyEdit(edit, { isRefactoring: true })
}

/** Un nombre de archivo sencillo a partir del tema: minúsculas, guiones bajos, sin acentos ni símbolos. */
function slugify(topic: string): string {
  const plain = topic
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return plain || 'tema'
}

/** Dónde se guarda lo ya generado para un (tema, nivel, idioma, proveedor): no volver a llamar al modelo. */
const AI_CACHE_DIR = 'ai-cache'

/**
 * Pide el código y la lección al modelo (dentro de una barra de progreso), en modo seguro: `runtime.trace`
 * usa un motor propio, aparte de cualquier sesión de documento, porque el archivo aún no existe. Si vale,
 * lo deja en la caché (una comodidad: si no se pudo escribir, la lección generada se entrega igual).
 */
async function runGenerateTopic(
  provider: AiProvider,
  options: TopicOptions,
  pyUri: vscode.Uri,
  cacheUri: vscode.Uri,
): Promise<{ title: string; code: string; lesson: Lesson } | null> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Prysel: generando con ${provider.id}…`,
    },
    async () => {
      let kernel: Kernel | null = null
      try {
        const parser = await getParser()
        kernel = await Kernel.start({
          python: await pythonFor(pyUri),
          cwd: vscode.workspace.getWorkspaceFolder(pyUri)?.uri.fsPath ?? dirname(pyUri.fsPath),
        })
        const runningKernel = kernel
        const runtime: TopicRuntime = {
          parse: (code) => buildProgram(parser.parse(code), code),
          trace: (code) => runningKernel.trace(code, TOPIC_TRACE_LIMIT, true),
        }
        const result = await generateTopic(provider, runtime, options)
        if (!result.ok || !result.lesson || !result.code || !result.title) {
          void vscode.window.showErrorMessage(
            `Prysel: no se pudo generar el tema tras ${result.attempts} intento(s). ${result.error ?? ''}`,
          )
          return null
        }
        const cached: CachedTopic = {
          title: result.title,
          code: result.code,
          lesson: result.lesson,
          cachedAt: new Date().toISOString(),
        }
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(cacheUri, '..'))
          await vscode.workspace.fs.writeFile(cacheUri, Buffer.from(JSON.stringify(cached), 'utf8'))
        } catch {
          // Sin la caché, la próxima vez vuelve a costar; no es motivo para no entregar esta.
        }
        return { title: result.title, code: result.code, lesson: result.lesson }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Prysel: no se pudo generar el tema. ${messageOf(error)}`,
        )
        return null
      } finally {
        kernel?.dispose()
      }
    },
  )
}

/**
 * «Explicar un tema»: la segunda entrada de la Fase D, la que no parte de un archivo que ya existe. Pide
 * un tema y, si hace falta, un nivel y el nombre del archivo a crear; la IA escribe un programa pequeño
 * en modo seguro (no es código del usuario) y su lección, sobre la traza real de ejecutarlo. Repetir el
 * mismo tema (con el mismo nivel, idioma y proveedor) no vuelve a llamar al modelo: sale de la caché.
 */
async function explainTopic(context: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) {
    void vscode.window.showInformationMessage(
      'Prysel: abre una carpeta para generar ahí un tema nuevo.',
    )
    return
  }
  const topic = await vscode.window.showInputBox({
    prompt: 'Qué tema quieres que explique (p. ej. «recursión», «ordenar con burbuja»)',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === '' ? 'Escribe un tema.' : null),
  })
  if (!topic) return
  const level = await vscode.window.showInputBox({
    prompt: 'Para quién es (opcional): «para quien empieza», «para quien ya sabe funciones»…',
    ignoreFocusOut: true,
  })
  const fileName = await vscode.window.showInputBox({
    prompt: 'Nombre del archivo a crear, en la raíz del proyecto',
    value: `${slugify(topic)}.py`,
    ignoreFocusOut: true,
    validateInput: (value) =>
      /^[\w.-]+\.py$/.test(value.trim()) ? null : 'Un nombre de archivo simple, acabado en «.py».',
  })
  if (!fileName) return
  const provider = await pickProvider(context)
  if (!provider) {
    void vscode.window.showInformationMessage(
      'Prysel: no hay ningún proveedor de IA disponible. Instala una extensión de chat (como Copilot) ' +
        'o configura una clave con «Prysel: Configurar la clave de Anthropic».',
    )
    return
  }

  const pyUri = vscode.Uri.joinPath(folder.uri, fileName.trim())
  const lessonUri = vscode.Uri.file(lessonFileFor(pyUri.fsPath))
  try {
    await vscode.workspace.fs.stat(pyUri)
    const overwrite = await vscode.window.showWarningMessage(
      `Prysel: «${fileName.trim()}» ya existe. ¿Sobrescribirlo con uno nuevo sobre este tema?`,
      { modal: true },
      'Sobrescribir',
    )
    if (overwrite !== 'Sobrescribir') return
  } catch {
    // No existe: se crea sin preguntar.
  }

  const options: TopicOptions = {
    topic,
    level: level || undefined,
    lang: 'es',
    source: fileName.trim(),
  }
  const cacheUri = vscode.Uri.joinPath(
    context.globalStorageUri,
    AI_CACHE_DIR,
    `${cacheKeyOf({ topic, level: options.level, lang: options.lang, providerId: provider.id })}.json`,
  )
  let cached: (CachedTopic & { lesson: Lesson }) | null = null
  try {
    const raw = JSON.parse(
      Buffer.from(await vscode.workspace.fs.readFile(cacheUri)).toString('utf8'),
    ) as CachedTopic
    // Una caché de una versión anterior del esquema no se usa a ciegas: si ya no valida, se regenera.
    const parsed = parseLesson(raw.lesson)
    cached =
      parsed.ok && typeof raw.title === 'string' && typeof raw.code === 'string'
        ? { ...raw, lesson: parsed.lesson }
        : null
  } catch {
    cached = null
  }

  let generated: { title: string; code: string; lesson: Lesson } | null = null
  if (cached) {
    const choice = await vscode.window.showInformationMessage(
      `Prysel: ya se generó una lección sobre «${topic}» (guardada el ${new Date(cached.cachedAt).toLocaleString()}). ¿La reutilizo o genero una nueva?`,
      { modal: true },
      'Usar la guardada',
      'Generar de nuevo',
    )
    if (!choice) return
    generated =
      choice === 'Usar la guardada'
        ? { title: cached.title, code: cached.code, lesson: cached.lesson }
        : await runGenerateTopic(provider, options, pyUri, cacheUri)
  } else {
    const proceed = await vscode.window.showWarningMessage(
      `Prysel enviará el tema «${topic}»${level ? ` (nivel: ${level})` : ''} a ${provider.id} para ` +
        'generar un programa y su lección. ¿Continuar?',
      { modal: true },
      'Continuar',
    )
    if (proceed !== 'Continuar') return
    generated = await runGenerateTopic(provider, options, pyUri, cacheUri)
  }
  if (!generated) return

  await vscode.workspace.fs.writeFile(pyUri, Buffer.from(generated.code, 'utf8'))
  await vscode.workspace.fs.writeFile(
    lessonUri,
    Buffer.from(JSON.stringify(generated.lesson, null, 2) + '\n', 'utf8'),
  )
  const doc = await vscode.workspace.openTextDocument(pyUri)
  await vscode.window.showTextDocument(doc)
  await postLesson(doc)
  void vscode.window.showInformationMessage(
    `Prysel: «${generated.title}» generado (${fileName.trim()}).`,
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

/**
 * Guarda en el guion dónde se dejó a mano una nota (o que vuelve a su sitio). Si el guion está abierto en
 * un editor se cambia ahí (respeta lo que aún no se guardó, y se deshace con Ctrl+Z en ese editor); si no,
 * en el disco. El guion vuelve al lienzo como siempre que cambia.
 */
async function moveNote(
  doc: vscode.TextDocument,
  beat: string,
  offset: { x: number; y: number } | null,
) {
  const uri = lessonUriOf(doc)
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
  let raw: string
  try {
    raw = open
      ? open.getText()
      : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
  } catch {
    return
  }
  const next = moveNoteIn(raw, beat, offset)
  if (next === null || next === raw) return
  if (open) {
    const change = new vscode.WorkspaceEdit()
    change.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(raw.length)), next)
    await vscode.workspace.applyEdit(change)
  } else {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(next, 'utf8'))
  }
  await postLesson(doc)
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
  const before = doc.getText()
  // El cambio dispara `onDidChangeTextDocument`, que reanaliza y reenvía el programa.
  if (!(await writeEdits(doc, edits))) {
    void refresh()
    return
  }
  historyOf(doc).applied(before, edits, doc.version)
  postHistory(doc)
}

/** Escribe unas ediciones en el documento. `false` si VS Code no las aplicó. */
async function writeEdits(doc: vscode.TextDocument, edits: readonly TextEdit[]): Promise<boolean> {
  const change = new vscode.WorkspaceEdit()
  for (const edit of edits) {
    const range = new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end))
    change.replace(doc.uri, range, edit.text)
  }
  return vscode.workspace.applyEdit(change)
}

/** Lo que se cambió desde el lienzo en cada documento, para deshacerlo desde el lienzo. */
const histories = new Map<string, EditHistory>()
const historyOf = (doc: vscode.TextDocument): EditHistory => {
  const key = doc.uri.toString()
  let history = histories.get(key)
  if (!history) {
    history = new EditHistory()
    histories.set(key, history)
  }
  return history
}

/** Cuánto se puede deshacer y rehacer ahora: el lienzo enciende o apaga sus botones. */
function postHistory(doc: vscode.TextDocument | null) {
  const sizes = doc ? historyOf(doc).sizes : { undo: 0, redo: 0 }
  postToAll({ type: 'history', ...sizes })
}

/**
 * Deshace (o rehace) el último cambio hecho desde el lienzo. Solo si el documento sigue como lo dejó el
 * lienzo: si se escribió en el editor entre medias, se avisa y la historia del lienzo se olvida (la del
 * editor, con Ctrl+Z allí, sigue intacta).
 */
async function stepHistory(direction: 'undo' | 'redo') {
  const doc = currentDoc
  if (!doc || doc.languageId !== 'python') return
  const history = historyOf(doc)
  const edits = direction === 'undo' ? history.nextUndo(doc.version) : history.nextRedo(doc.version)
  if (!edits) {
    postHistory(doc)
    if (history.sizes.undo === 0 && history.sizes.redo === 0) {
      void vscode.window.setStatusBarMessage(
        direction === 'undo'
          ? 'Prysel: nada que deshacer desde el lienzo (lo escrito en el editor se deshace allí).'
          : 'Prysel: nada que rehacer.',
        4000,
      )
    }
    return
  }
  const before = doc.getText()
  if (!validEdits(edits, before.length) || !(await writeEdits(doc, edits))) {
    history.clear()
    postHistory(doc)
    return
  }
  if (direction === 'undo') history.undone(before, doc.version)
  else history.redone(before, doc.version)
  postHistory(doc)
}

// ───────────────────────── órdenes: el motor JEV ─────────────────────────

/** Dónde vive, en el llavero del sistema, la clave de la API de TypeSafe (Jev). */
const TYPESAFE_SECRET = 'prysel.typesafeApiKey'

/** Se avisó ya, en este espacio de trabajo, de lo que las órdenes mandan fuera del equipo. */
const COMMAND_CONSENT = 'prysel.commandConsent'

/** El contexto de la extensión: las órdenes llegan del lienzo, que no lo trae consigo. */
let extensionContext: vscode.ExtensionContext | null = null

/**
 * Quién decide las órdenes: Jev de TypeSafe, con la clave guardada; o, si se pide en el ajuste
 * `prysel.jevEngine`, el decisor local (sin red, por palabras clave). Sin clave no hay Jev: `null`.
 */
async function pickDecider(context: vscode.ExtensionContext): Promise<Decider | null> {
  const settings = vscode.workspace.getConfiguration('prysel')
  if (settings.get<string>('jevEngine') === 'local') return callLog.decider(localDecider())
  const key = await context.secrets.get(TYPESAFE_SECRET)
  if (!key) return null
  return callLog.decider(
    typesafeDecider({
      apiKey: key,
      model: settings.get<string>('jevModel') || DEFAULT_JEV_MODEL,
    }),
  )
}

/**
 * Las piezas que nacieron «generándose» y esperan su contenido, por su id. `waiting`: la orden ya se
 * decidió, pero la pieza aún no está en el código (la escribe el lienzo). `running`: se está redactando.
 */
const fills = new Map<
  string,
  { uri: string; command: string; template: TemplateId; state: 'waiting' | 'running'; at: number }
>()

/** Una pieza que no llega al código en este tiempo ya no va a llegar (la edición se descartó). */
const FILL_PATIENCE_MS = 30_000

/** Los documentos que ya se miraron en esta sesión: en el primer vistazo se limpian las marcas viejas. */
const tended = new Set<string>()

const newGenId = () => Math.random().toString(36).slice(2, 8).padEnd(6, '0')

/** Lo que hace falta para decidir una orden: quién decide, quién redacta y sobre qué documento. */
interface OrderContext {
  doc: vscode.TextDocument
  message: CommandMessage
  decider: Decider
  provider: AiProvider | null
  /** Lo que se estaba construyendo cuando llegó esta orden, y se dejó a medias para tenerla en cuenta. */
  resume?: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Cuánto se espera a que el lienzo escriba lo que se le mandó, antes de dar el paso por perdido. */
const STEP_PATIENCE_MS = 3000
/** Entre dos pasos que no cambian el código (ir a ver algo, plegar): lo justo para que se vea cada uno. */
const STEP_PAUSE_MS = 700

/**
 * Una orden del lienzo: el motor JEV decide y el lienzo ejecuta lo decidido. Aquí no se toca el código de
 * las órdenes sencillas: la directiva vuelve al lienzo, que la escribe por el mismo camino que cualquier
 * otro cambio suyo. Las complejas (escribir un algoritmo, varias órdenes en una) las redacta la IA
 * generativa y las juzga el JEV (ver `jev/compose.ts`).
 */
async function handleCommand(
  context: vscode.ExtensionContext,
  message: CommandMessage,
  resume?: string,
) {
  const doc = currentDoc
  if (!doc || doc.languageId !== 'python') return
  const reply = (directive: Directive) => {
    postToAll({
      type: 'decision',
      id: message.id,
      version: doc.version,
      directive,
      evidence: [],
      engine: '',
      jevMs: 0,
    })
  }
  const changed = () => {
    void refresh()
    reply({ kind: 'failed', say: 'El archivo cambió mientras tanto. Repite la orden.' })
  }
  if (doc.version !== message.version) return changed()
  const decider = await pickDecider(context)
  if (!decider) {
    return reply({
      kind: 'failed',
      say: 'Falta la clave de TypeSafe: sin ella no hay motor JEV que decida.',
      needsKey: true,
    })
  }
  const provider = await pickProvider(context)
  // Lo que sale del equipo se dice una vez por espacio de trabajo, antes de la primera orden.
  if (
    (decider.id !== 'local' || provider) &&
    !context.workspaceState.get<boolean>(COMMAND_CONSENT)
  ) {
    const sent = [
      ...(decider.id === 'local'
        ? []
        : [
            'a TypeSafe (Jev), el texto de cada orden, un esquema del programa (la primera línea de cada paso) y el código que se escriba, para juzgarlo',
          ]),
      ...(provider
        ? [
            `a ${provider.id}, el texto de cada orden y el código del archivo, para escribir lo que se pide`,
          ]
        : []),
    ]
    const proceed = await vscode.window.showWarningMessage(
      `Las órdenes de Prysel envían: ${sent.join('; y ')}. ¿Continuar?`,
      { modal: true },
      'Continuar',
    )
    if (proceed !== 'Continuar') return reply({ kind: 'failed', say: 'Orden cancelada.' })
    await context.workspaceState.update(COMMAND_CONSENT, true)
  }
  if (doc.version !== message.version) return changed()
  const now = Date.now()
  for (const [id, fill] of fills) {
    if (fill.state === 'waiting' && now - fill.at > FILL_PATIENCE_MS) fills.delete(id)
  }
  const order: OrderContext = {
    doc,
    message,
    decider,
    provider,
    ...(resume === undefined ? {} : { resume }),
  }
  try {
    const decision = await decideOrder(order, message.text, false)
    if (decision === null) return changed()
    if (decision.directive.kind !== 'several' || !provider) {
      await carryOut(order, message.text, decision)
      return
    }
    // Varias órdenes en una: la IA generativa la parte, y cada trozo vuelve a pasar por el JEV.
    const steps = await splitOrder(provider, message.text)
    if (!steps) {
      const single = await decideOrder(order, message.text, true)
      if (single === null) return changed()
      await carryOut(order, message.text, single)
      return
    }
    for (const [index, step] of steps.entries()) {
      const before = doc.version
      const part = await decideOrder(order, step, true)
      if (part === null) return changed()
      const { directive } = part
      const label = `${index + 1}/${steps.length}`
      // Un trozo que no se entiende detiene el resto: seguir sería hacer otra cosa que la que se pidió.
      if (directive.kind !== 'do') {
        const why = directive.kind === 'ask' ? directive.question : directive.say
        postToAll({
          type: 'decision',
          id: message.id,
          version: doc.version,
          ...part,
          directive: { kind: 'unknown', say: `Me paro en el paso ${label} («${step}»): ${why}` },
        })
        return
      }
      const said = { ...directive, say: `${label} · ${directive.say}` }
      const wrote = await carryOut(order, step, { ...part, directive: said })
      // Lo que escribe el lienzo tarda un instante en llegar al documento: el paso siguiente lo necesita.
      if (
        said.effect.type === 'action' ||
        said.effect.type === 'undo' ||
        said.effect.type === 'redo'
      ) {
        const until = Date.now() + STEP_PATIENCE_MS
        while (doc.version === before && Date.now() < until) await sleep(25)
      } else if (!wrote) await sleep(STEP_PAUSE_MS)
      await refresh()
    }
  } catch (error) {
    reply({
      kind: 'failed',
      say: error instanceof JevError ? error.message : `No se pudo decidir. ${messageOf(error)}`,
      ...(error instanceof JevError && error.reason === 'key' ? { needsKey: true } : {}),
    })
  }
}

/** Le pregunta al JEV qué hacer con una orden. `null` si el documento cambió mientras decidía. */
async function decideOrder(order: OrderContext, text: string, single: boolean) {
  const { doc, message, decider, provider } = order
  const version = doc.version
  const program = await analyse(doc)
  const decision = await decideCommand(
    {
      text,
      program,
      selected: message.selected,
      focus: message.focus,
      // Llega de la caja de órdenes: es una orden, no algo oído de pasada.
      typed: true,
      ...(message.force && !single ? { forced: message.force } : {}),
      ...(message.pointed ? { pointed: message.pointed } : {}),
      ...(provider ? { genId: newGenId() } : {}),
      ...(single ? { single: true } : {}),
      ...(lastWork.has(doc.uri.toString())
        ? { last: lastWork.get(doc.uri.toString()) as { from: number; to: number } }
        : {}),
    },
    decider,
  )
  return doc.version === version ? decision : null
}

/**
 * Cumple una decisión: se la manda al lienzo y, si deja algo en marcha (el contenido de una pieza, el
 * código de una orden compleja, una explicación, la lección), lo pone en marcha. Devuelve si escribió en
 * el documento desde aquí.
 */
async function carryOut(
  order: OrderContext,
  text: string,
  decision: Awaited<ReturnType<typeof decideCommand>>,
): Promise<boolean> {
  const { doc, message, decider, provider } = order
  const { directive } = decision
  if (directive.kind === 'do' && directive.pending) {
    fills.set(directive.pending.id, {
      uri: doc.uri.toString(),
      command: text,
      template: directive.pending.template,
      state: 'waiting',
      at: Date.now(),
    })
  }
  postToAll({ type: 'decision', id: message.id, version: doc.version, ...decision })
  if (directive.kind !== 'do') {
    // La pregunta de plantilla ya está en pantalla; si se puede hacer una mejor, la sustituye.
    if (!message.force) await askBetter(order, text, decision)
    return false
  }
  const { effect } = directive
  if ((effect.type === 'compose' || effect.type === 'modify') && provider) {
    // Si se interrumpió algo para atender esto, la IA lo sabe: termina lo que faltaba con lo nuevo en cuenta.
    const asked =
      order.resume === undefined
        ? text
        : `${text}\n(Se estaba construyendo «${order.resume}» y se dejó a medias al oír esto. Tenlo en cuenta: termina lo que falte o cámbialo, sin repetir lo que ya está escrito.)`
    return runDirected(doc, decider, provider, asked, effect, text)
  }
  if (effect.type === 'lesson') {
    await vscode.commands.executeCommand('prysel.explainFile')
    if (vscode.workspace.isTrusted) await traceDocument(doc)
    return false
  }
  if (directive.explain !== undefined && provider) {
    const program = await analyse(doc)
    const node = program.nodes.find((n) => n.id === directive.explain)
    const said = node ? await explainNode(provider, program, node) : null
    if (said && node) postToAll({ type: 'say', text: said, focus: node.id })
  }
  return false
}

/** Lo que se está construyendo paso a paso en cada documento: con esto se detiene. */
const builds = new Map<string, AbortController>()

/** Las líneas de lo último que una orden construyó o cambió en cada documento: «eso», «lo de antes». */
const lastWork = new Map<string, { from: number; to: number }>()

/** Lo que el lienzo está diciendo en voz alta y aún no ha avisado de que terminó, por su número. */
const speaking = new Map<number, (spoke: boolean) => void>()
let speechSeq = 0

/** Lo más que se espera a que el lienzo avise de que terminó de hablar. */
const SPEECH_PATIENCE_MS = 25_000
/** Entre el final de una frase y lo siguiente: un respiro. */
const AFTER_SPEECH_MS = 280

/** Lo que se está construyendo en un documento: qué se pidió, qué hay preparado, y cuándo termina. */
interface Building {
  command: string
  /** El código de los trozos ya preparados (juzgados, con sus frases) y aún sin escribir. */
  pending: string[]
  done: Promise<void>
}
const building = new Map<string, Building>()

/**
 * Una orden llega del lienzo. Si no se está construyendo nada, se atiende sin más. Si se está construyendo,
 * es una interrupción: el JEV mira lo que se pedía, lo que hay preparado sin escribir y lo que se acaba de
 * decir, y decide: seguir (lo preparado vale), ajustar (se para, y lo que faltaba se rehace con lo nuevo en
 * cuenta) u otra cosa (se para y se atiende lo nuevo).
 */
async function interrupt(context: vscode.ExtensionContext, message: CommandMessage) {
  const doc = currentDoc
  const active = doc ? building.get(doc.uri.toString()) : undefined
  if (!doc || !active) return handleCommand(context, message)
  let what: Interruption = 'otra'
  const decider = await pickDecider(context)
  if (decider) {
    try {
      what = (
        await judgeInterruption(decider, {
          building: active.command,
          said: message.text,
          pending: active.pending.join('\n'),
        })
      ).what
    } catch {
      what = 'otra'
    }
  }
  if (what === 'seguir') {
    postToAll({
      type: 'decision',
      id: message.id,
      version: doc.version,
      directive: { kind: 'ignored', say: 'Sigo con lo que estaba construyendo.' },
      evidence: [],
      engine: decider?.id ?? '',
      jevMs: 0,
    })
    return
  }
  // Se deja lo que se estaba haciendo (lo escrito se queda) y, cuando haya parado, se atiende lo nuevo.
  stopBuild(doc)
  await active.done
  await refresh()
  // El lienzo mandó la orden con la versión que veía entonces: la de ahora es la que vale.
  return handleCommand(
    context,
    { ...message, version: doc.version },
    what === 'ajustar' ? active.command : undefined,
  )
}

/** Detiene la construcción en marcha de un documento, si la hay. Lo ya escrito se queda. */
function stopBuild(doc: vscode.TextDocument | null) {
  if (doc) builds.get(doc.uri.toString())?.abort()
}

/** Espera, pero no más allá de que se detenga la construcción. */
async function pauseFor(ms: number, signal: AbortSignal) {
  const until = Date.now() + ms
  while (!signal.aborted && Date.now() < until) await sleep(Math.min(40, ms))
}

/**
 * Una orden compleja la lleva el **director** (`jev/director.ts`), por partes: el contexto, el plan, cada
 * etapa y cada paso son llamadas distintas a la IA generativa y al JEV, y entre ellas el diagrama ya va
 * cambiando. Aquí solo se le presta lo que necesita de VS Code: el documento, el lienzo y el reloj.
 */
async function runDirected(
  doc: vscode.TextDocument,
  decider: Decider,
  provider: AiProvider,
  command: string,
  effect: Extract<Effect, { type: 'compose' | 'modify' }>,
  /** Lo que dijo el usuario, sin lo que se le añade para la IA. */
  said?: string,
): Promise<boolean> {
  const key = doc.uri.toString()
  // La versión pedida (si se está rehaciendo con otra): se toma ahora, antes de esperar a nada.
  const flavour = remaking
  builds.get(key)?.abort()
  const control = new AbortController()
  builds.set(key, control)
  const { signal } = control
  /** Lo que el director tiene preparado y aún no ha escrito: la recámara. */
  const state: Building = { command: said ?? command, pending: [], done: Promise.resolve() }
  let finish: () => void = () => undefined
  state.done = new Promise<void>((resolve) => {
    finish = resolve
  })
  building.set(key, state)
  const parser = await getParser()
  const shown = () => currentDoc?.uri.toString() === key
  /** El aviso pendiente de lo último que se mandó decir: se cumple cuando el lienzo termina de hablar. */
  let heard: Promise<boolean> | null = null
  /** Por dónde ha ido pasando el trabajo: lo que después es «lo último que se hizo». */
  let span: { from: number; to: number } | null = null
  const host: Stagehand = {
    signal,
    program: () => analyse(doc),
    // Aquí el programa corre en el equipo: solo en un espacio de trabajo de confianza y en modo seguro.
    run: () =>
      vscode.workspace.isTrusted
        ? sessionFor(doc).trace(doc.getText(), 20_000, true, true, { seed: 7, finish: true })
        : Promise.resolve(null),
    parses: (code) => !parser.parse(code).rootNode.hasError,
    async write(change) {
      const before = doc.getText()
      const { edits } = change
      if (edits.length === 0) return null
      // El diagrama se rehace tras cada paso: lo que no deje un Python válido no se escribe.
      if (
        !validEdits(edits, before.length) ||
        parser.parse(applyTextEdits(before, edits)).rootNode.hasError
      ) {
        return 'El siguiente paso no deja un programa válido: me detengo.'
      }
      if (!(await writeEdits(doc, edits))) return 'No se pudo escribir en el archivo.'
      historyOf(doc).applied(before, edits, doc.version)
      postHistory(doc)
      return null
    },
    async show(event) {
      if (event.type === 'step' && event.effect !== 'leaving') {
        span = span
          ? { from: Math.min(span.from, event.line), to: Math.max(span.to, event.line) }
          : { from: event.line, to: event.line }
      }
      if (!shown()) return
      if (event.type === 'progress') {
        postToAll({ type: 'progress', gen: effect.gen, text: event.text })
        return
      }
      if (event.type === 'architecture') {
        postToAll({
          type: 'architecture',
          modules: event.modules,
          ...(event.complete ? { complete: true } : {}),
        })
        return
      }
      // La versión que se eligió para una petición abierta: el lienzo ofrece las otras.
      if (event.type === 'flavours') {
        postToAll({
          type: 'flavours',
          command: said ?? command,
          options: event.options,
          chosen: event.chosen,
        })
        return
      }
      // Lo que lleva voz lleva un número: el lienzo avisa con él cuando ha terminado de decirlo.
      const seq = event.say === '' ? undefined : ++speechSeq
      heard =
        seq === undefined
          ? null
          : new Promise<boolean>((resolve) => {
              speaking.set(seq, resolve)
            })
      if (event.type === 'say') {
        postToAll({ type: 'say', text: event.say, ...(seq === undefined ? {} : { seq }) })
        return
      }
      // Primero el programa nuevo, luego el paso: el lienzo enfoca un nodo que ya tiene.
      await refresh()
      postToAll({
        type: 'step',
        gen: effect.gen,
        index: event.index,
        say: event.say,
        line: event.line,
        effect: event.effect,
        ...(event.wide ? { wide: true } : {}),
        ...(event.mark ? { mark: event.mark } : {}),
        ...(seq === undefined ? {} : { seq }),
      })
    },
    wait: (ms) => pauseFor(ms, signal),
    buffer(pending) {
      state.pending = [...pending]
    },
    async settle(estimate) {
      const started = Date.now()
      const pending = heard
      heard = null
      if (!pending || !shown()) return pauseFor(estimate, signal)
      // Hasta que el lienzo avise de que terminó de hablar (o se detenga, o tarde demasiado en avisar).
      const spoke = await Promise.race([
        pending,
        pauseFor(Math.max(SPEECH_PATIENCE_MS, estimate * 4), signal).then(() => false),
      ])
      // Si no hubo voz (está apagada), se deja el tiempo de leerlo.
      await pauseFor(
        spoke ? AFTER_SPEECH_MS : Math.max(0, estimate - (Date.now() - started)),
        signal,
      )
    },
  }
  let outcome: Outcome
  try {
    outcome =
      effect.type === 'compose'
        ? await build(
            host,
            { decider, provider },
            {
              command,
              gen: effect.gen,
              place: effect.place,
              where: effect.where,
              outline: effect.outline,
              ...(effect.teach ? { teach: true } : {}),
              ...(flavour ? { flavour } : {}),
            },
          )
        : await modify(
            host,
            { decider, provider },
            {
              command,
              ...(effect.lines ? { lines: effect.lines } : {}),
              ...(effect.scope ? { scope: effect.scope } : {}),
            },
          )
  } catch (error) {
    outcome = {
      written: 0,
      stopped: signal.aborted,
      trouble: `Algo falló a mitad. ${messageOf(error)}`,
      doubt: false,
      evidence: [],
      jevMs: 0,
    }
  }
  control.abort()
  if (builds.get(key) === control) builds.delete(key)
  if (building.get(key) === state) building.delete(key)
  finish()
  if (span) {
    // Hasta el final de la última sentencia tocada (si es un bloque, con su cuerpo).
    const { from, to } = span as { from: number; to: number }
    const tail = (await analyse(doc)).nodes.find((n) => n.range && n.line === to)
    lastWork.set(key, { from, to: tail?.lineEnd ?? to })
  }
  if (shown()) {
    await refresh()
    postToAll({
      type: 'generated',
      gen: effect.gen,
      ok: outcome.written > 0,
      say: summaryOf(outcome, effect.type === 'modify' ? ['cambio', 'cambios'] : ['paso', 'pasos']),
      ...(outcome.evidence.length > 0 ? { evidence: outcome.evidence } : {}),
      jevMs: outcome.jevMs,
      done: true,
    })
  }
  return outcome.written > 0
}

/**
 * Cuando el motor duda (o no puede), la pregunta de plantilla se cambia por una concreta: la redacta la IA
 * generativa mirando el programa, y el JEV comprueba que cada salida que ofrece se puede cumplir (`jev/ask.ts`).
 */
async function askBetter(
  order: OrderContext,
  text: string,
  decision: Awaited<ReturnType<typeof decideCommand>>,
) {
  const { doc, message, decider, provider } = order
  const { directive } = decision
  if (!provider || (directive.kind !== 'ask' && directive.kind !== 'unknown')) return
  const version = doc.version
  const program = await analyse(doc)
  const chosen = program.nodes.find((n) => n.id === message.selected)
  const context = await contextFor(decider, {
    command: text,
    program,
    ...(chosen ? { must: [chosen.line] } : {}),
  })
  const last = lastWork.get(doc.uri.toString())
  const better = await smartAsk(provider, decider, {
    input: {
      text,
      program,
      selected: message.selected,
      focus: message.focus,
      // Llega de la caja de órdenes: es una orden, no algo oído de pasada.
      typed: true,
      genId: newGenId(),
      ...(last ? { last } : {}),
    },
    context: context.text,
    directive,
    evidence: decision.evidence,
    ...(chosen
      ? { selected: `línea ${chosen.line}: ${(chosen.text ?? chosen.label).split('\n')[0]}` }
      : {}),
  })
  if (!better || doc.version !== version) return
  // Si solo queda una lectura posible de lo que se dijo, no se pregunta: se hace.
  const [only] = better.options
  if (directive.kind === 'unknown' && better.options.length === 1 && only?.order !== undefined) {
    const clear = await decideOrder(order, only.order, true)
    if (clear?.directive.kind === 'do') {
      await carryOut(order, only.order, clear)
      return
    }
  }
  postToAll({
    type: 'decision',
    id: message.id,
    version: doc.version,
    ...decision,
    directive: better,
  })
}

// ───────────────────────── qué modelos se usan ─────────────────────────

/** Le dice al lienzo qué IA redacta y qué motor decide ahora: lo enseña en la caja de órdenes. */
async function postModels() {
  const context = extensionContext
  if (!context || webviews.size === 0) return
  const [provider, decider] = await Promise.all([pickProvider(context), pickDecider(context)])
  gistProvider = provider
  gistDecider = decider
  postToAll({ type: 'models', ai: provider?.id ?? null, jev: decider?.id ?? null })
}

interface ModelItem extends vscode.QuickPickItem {
  /** Los ajustes que deja puestos al elegirlo. */
  settings?: Record<string, string | boolean>
  /** La clave que necesita (dónde vive) y el comando que la pide. */
  secret?: string
  ask?: string
}

/**
 * Elegir con qué modelos trabaja Prysel: la IA que redacta (DeepSeek, Anthropic, los de VS Code) y el motor
 * que decide (Jev o el local). Lo que falta una clave lo dice, y la pide al elegirlo.
 */
async function pickModel(context: vscode.ExtensionContext) {
  const settings = vscode.workspace.getConfiguration('prysel')
  const has = async (secret: string) => Boolean(await context.secrets.get(secret))
  const [deepseek, anthropic, typesafe] = await Promise.all([
    has(DEEPSEEK_SECRET),
    has(ANTHROPIC_SECRET),
    has(TYPESAFE_SECRET),
  ])
  let installed: vscode.LanguageModelChat[] = []
  try {
    installed = await vscode.lm.selectChatModels({})
  } catch {
    installed = []
  }
  const ai = settings.get<string>('aiProvider') ?? 'auto'
  const now = {
    deepseek: settings.get<string>('deepseekModel') || DEFAULT_DEEPSEEK_MODEL,
    thinking: settings.get<boolean>('deepseekThinking') === true,
    anthropic: settings.get<string>('anthropicModel') || DEFAULT_ANTHROPIC_MODEL,
    vscode: settings.get<string>('vscodeModel') ?? '',
    jev: settings.get<string>('jevModel') || DEFAULT_JEV_MODEL,
    engine: settings.get<string>('jevEngine') ?? 'typesafe',
  }
  const mark = (on: boolean, label: string) => (on ? `$(check) ${label}` : `$(blank) ${label}`)
  const needs = (ready: boolean) => (ready ? '' : '$(key) falta la clave: se pedirá al elegirlo')
  const items: ModelItem[] = [
    {
      label: 'IA que redacta el código y las explicaciones',
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label: mark(ai === 'auto', 'Automático'),
      description: 'el de VS Code si hay uno; si no, Anthropic; si no, DeepSeek',
      settings: { aiProvider: 'auto' },
    },
    // Cada modelo, sin razonar (rápido: lo indicado para construir paso a paso) y razonando.
    ...DEEPSEEK_MODELS.flatMap((model) =>
      [false, true].map((thinking): ModelItem => ({
        label: mark(
          ai === 'deepseek' && now.deepseek === model && now.thinking === thinking,
          `DeepSeek · ${model}${thinking ? ' · razonando' : ''}`,
        ),
        description: thinking
          ? 'piensa antes de contestar: más lento, cada frase tarda'
          : 'contesta directo: rápido, lo indicado para construir paso a paso',
        detail: needs(deepseek),
        settings: { aiProvider: 'deepseek', deepseekModel: model, deepseekThinking: thinking },
        secret: DEEPSEEK_SECRET,
        ask: 'prysel.setDeepseekKey',
      })),
    ),
    {
      label: mark(ai === 'anthropic', `Anthropic · ${now.anthropic}`),
      detail: needs(anthropic),
      settings: { aiProvider: 'anthropic' },
      secret: ANTHROPIC_SECRET,
      ask: 'prysel.setAnthropicKey',
    },
    ...installed.map((model): ModelItem => ({
      label: mark(
        ai === 'vscode' && (now.vscode === model.id || now.vscode === ''),
        `VS Code · ${model.name}`,
      ),
      description: `${model.vendor} · sin clave`,
      settings: { aiProvider: 'vscode', vscodeModel: model.id },
    })),
    {
      label: 'Motor JEV: quién decide qué hacer con cada orden',
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...['jev-latest', 'jev-preview'].map((model): ModelItem => ({
      label: mark(now.engine === 'typesafe' && now.jev === model, `Jev (TypeSafe) · ${model}`),
      detail: needs(typesafe),
      settings: { jevEngine: 'typesafe', jevModel: model },
      secret: TYPESAFE_SECRET,
      ask: 'prysel.setTypesafeKey',
    })),
    {
      label: mark(now.engine === 'local', 'Local · sin red'),
      description: 'reconoce palabras clave, no entiende: para probar sin clave',
      settings: { jevEngine: 'local' },
    },
  ]
  const chosen = await vscode.window.showQuickPick(items, {
    title: 'Prysel: modelos',
    placeHolder: 'Elige la IA que redacta o el motor que decide',
    matchOnDescription: true,
  })
  if (!chosen?.settings) return
  for (const [name, value] of Object.entries(chosen.settings)) {
    await settings.update(name, value, vscode.ConfigurationTarget.Global)
  }
  if (chosen.secret && chosen.ask && !(await has(chosen.secret))) {
    await vscode.commands.executeCommand(chosen.ask)
  }
  await postModels()
}

/**
 * Tras cada análisis: las piezas marcadas como «generándose» que acaban de llegar al código empiezan a
 * redactarse. Y la primera vez que se mira un documento, una marca sin nadie que la esté redactando (se
 * cerró VS Code a medias) se retira: el código no se queda diciendo que algo está en marcha cuando no lo está.
 */
function tendGenerating(doc: vscode.TextDocument, program: Awaited<ReturnType<typeof analyse>>) {
  const key = doc.uri.toString()
  const firstLook = !tended.has(key)
  tended.add(key)
  for (const node of program.nodes) {
    const gen = node.generating
    if (gen === undefined) continue
    const fill = fills.get(gen)
    if (fill?.uri === key && fill.state === 'waiting') {
      fill.state = 'running'
      void runFill(doc, gen)
    } else if (!fill && firstLook) {
      void writeChange(doc, (current) => clearGenerating(current, gen).edits, false)
      // De una en una: la edición vuelve a analizar el documento, y ahí no es ya el primer vistazo.
      tended.delete(key)
      return
    }
  }
}

/**
 * Escribe en el documento un cambio calculado sobre su análisis de ahora mismo. `remember`: entra en la
 * historia del lienzo (se deshace desde él, como lo que el usuario cambia a mano).
 */
async function writeChange(
  doc: vscode.TextDocument,
  build: (program: Awaited<ReturnType<typeof analyse>>) => TextEdit[],
  remember = true,
): Promise<boolean> {
  const edits = build(await analyse(doc))
  const before = doc.getText()
  if (edits.length === 0 || !validEdits(edits, before.length)) return false
  if (!(await writeEdits(doc, edits))) return false
  if (remember) {
    historyOf(doc).applied(before, edits, doc.version)
    postHistory(doc)
  }
  return true
}

/** Redacta el contenido de una pieza y lo pone en el sitio de su plantilla; si no vale, la plantilla se queda. */
async function runFill(doc: vscode.TextDocument, gen: string) {
  const fill = fills.get(gen)
  const context = extensionContext
  if (!fill || !context) return
  let code = ''
  let finished = false
  const finish = async (say: string | null, error?: string) => {
    if (finished) return
    finished = true
    fills.delete(gen)
    let line: number | undefined
    const written =
      say !== null &&
      (await writeChange(doc, (program) => {
        if (!untouchedTemplate(program, gen, fill.template)) return []
        const change = fillGenerated(program, gen, code)
        line = change.select?.line
        return change.edits
      }))
    // No se escribió (falló, o alguien ya había tocado la plantilla): se quita la marca y queda como está.
    if (!written) await writeChange(doc, (program) => clearGenerating(program, gen).edits)
    // El lienzo ya enseña otro archivo: lo que se diga de este no le dice nada.
    if (currentDoc?.uri.toString() !== doc.uri.toString()) return
    postToAll({
      type: 'generated',
      gen,
      ok: written,
      ...(written && say !== null ? { say } : {}),
      ...(written || error === undefined ? {} : { error }),
      ...(line === undefined ? {} : { line }),
    })
  }
  try {
    const provider = await pickProvider(context)
    if (!provider) return await finish(null, 'No hay una IA con la que escribir el contenido.')
    const parser = await getParser()
    const result = await generateFill(
      provider,
      {
        parse: (text) => {
          const tree = parser.parse(text)
          return { program: buildProgram(tree, text), hasError: tree.rootNode.hasError }
        },
      },
      { command: fill.command, template: fill.template, program: await analyse(doc), genId: gen },
    )
    if (!result.ok) return await finish(null, result.error)
    code = result.code
    await finish(result.say)
  } catch (error) {
    await finish(null, messageOf(error))
  }
}

/**
 * Un programa nuevo donde construir lo que se pide cuando no hay ninguno de Python abierto: `programa.py` (o
 * `programa-2.py`…) en la carpeta del espacio de trabajo; sin carpeta, uno sin guardar. Se abre a la vista y
 * pasa a ser el que enseña el lienzo.
 */
async function newProgramDoc(): Promise<vscode.TextDocument | null> {
  try {
    let doc: vscode.TextDocument | null = null
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (folder) {
      for (let n = 1; n < 100 && !doc; n++) {
        const uri = vscode.Uri.joinPath(folder.uri, n === 1 ? 'programa.py' : `programa-${n}.py`)
        const taken = await vscode.workspace.fs.stat(uri).then(
          () => true,
          () => false,
        )
        if (taken) continue
        await vscode.workspace.fs.writeFile(uri, new Uint8Array())
        doc = await vscode.workspace.openTextDocument(uri)
      }
    }
    doc ??= await vscode.workspace.openTextDocument({ language: 'python', content: '' })
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: true,
      preview: false,
    })
    currentDoc = doc
    await refresh()
    return doc
  } catch (error) {
    vscode.window.showErrorMessage(
      `Prysel: no pude crear un programa donde construirlo. ${messageOf(error)}`,
    )
    return null
  }
}

/**
 * Arrancar un programa que no hace nada: se le añade su etapa de arranque (y se puede deshacer). Si no se
 * sabe con qué valores, se dice.
 */
async function launch(doc: vscode.TextDocument) {
  const edit = await gistsFor(doc).launchEdit()
  const before = doc.getText()
  if (edit && (await writeEdits(doc, [edit]))) {
    historyOf(doc).applied(before, [edit], doc.version)
    postHistory(doc)
    return
  }
  postToAll({
    type: 'say',
    text: 'No sé con qué valores arrancarlo. Dímelo tú: «arráncalo con …».',
  })
}

/**
 * «No, eso no»: se deshace lo que escribió la última orden que de verdad escribió algo (las que solo
 * miraron no dejaron nada), volviendo justo a donde estaba la historia al darla.
 */
async function undoOrder() {
  const doc = currentDoc
  if (!doc) return
  stopBuild(doc)
  const key = doc.uri.toString()
  const marks = orderMarks.get(key) ?? []
  const sizes = () => historyOf(doc).sizes.undo
  let to = marks.pop()
  while (to !== undefined && to >= sizes() && marks.length > 0) to = marks.pop()
  const floor = to === undefined || to >= sizes() ? Math.max(0, sizes() - 1) : to
  while (sizes() > floor) {
    const before = sizes()
    await stepHistory('undo')
    if (sizes() >= before) break
  }
}

/**
 * Rehace el programa con **otra versión** de las que se propusieron: lo que se estuviera construyendo se
 * para, el programa se vacía (queda en el historial: se puede deshacer) y se construye de nuevo con ella.
 */
async function remake(context: vscode.ExtensionContext, message: CommandMessage, flavour: Flavour) {
  const doc = currentDoc
  if (!doc || doc.languageId !== 'python') return
  const active = building.get(doc.uri.toString())
  if (active) {
    stopBuild(doc)
    await active.done
  }
  const before = doc.getText()
  if (before.length > 0) {
    const edits = [{ start: 0, end: before.length, text: '' }]
    if (!(await writeEdits(doc, edits))) return
    historyOf(doc).applied(before, edits, doc.version)
    postHistory(doc)
  }
  await refresh()
  remaking = flavour
  try {
    await handleCommand(context, { ...message, version: doc.version, selected: null, focus: null })
  } finally {
    remaking = null
  }
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
  webview.onDidReceiveMessage(onWebviewMessage)
}

/** Lo que llega de un lienzo. */
function onWebviewMessage(message: unknown) {
  const parsed = parseHostMessage(message)
  // (Para las pruebas: qué llegó, y si no se entendió.)
  const kind = (message as { type?: unknown } | null)?.type
  heardLog.push(
    parsed?.type === 'webviewError'
      ? `fallo en el lienzo: ${parsed.message}`
      : parsed
        ? parsed.type
        : `no válido: ${String(kind)}`,
  )
  if (parsed?.type === 'webviewError') {
    console.error(`Prysel: fallo en el lienzo: ${parsed.message}`)
    return
  }
  if (heardLog.length > 30) heardLog.splice(0, heardLog.length - 30)
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
  if (parsed.type === 'command') {
    void (async () => {
      // Se pide algo sin un programa de Python abierto: se le crea uno, y se construye ahí. (Antes la
      // orden se perdía sin decir nada.)
      let doc = currentDoc
      let message = parsed
      if (!doc || doc.languageId !== 'python') {
        doc = await newProgramDoc()
        if (!doc) return
        message = { ...parsed, version: doc.version }
      }
      // Dónde estaba la historia al empezar esta orden: «no, eso no» vuelve justo hasta aquí.
      const marks = orderMarks.get(doc.uri.toString()) ?? []
      marks.push(historyOf(doc).sizes.undo)
      orderMarks.set(doc.uri.toString(), marks.slice(-40))
      // Rehacerlo con otra de las versiones que se propusieron: se empieza de cero (se puede deshacer).
      if (message.flavour && extensionContext) {
        await remake(extensionContext, message, message.flavour)
        return
      }
      // Mientras se construye algo, lo que diga el usuario lo interrumpe: el JEV decide si lo que estaba
      // preparado sigue valiendo, si hay que rehacer lo que faltaba, o si es otra cosa.
      if (extensionContext) await interrupt(extensionContext, message)
    })()
    return
  }
  // Lo que mira el motor de «qué hace»: probar una función, jugar el programa, otra tirada, qué mirar.
  if (
    parsed.type === 'tryCall' ||
    parsed.type === 'play' ||
    parsed.type === 'reroll' ||
    parsed.type === 'watch'
  ) {
    const doc = currentDoc
    if (!doc || doc.languageId !== 'python') return
    const gists = gistsFor(doc)
    if (parsed.type === 'tryCall') void gists.tryCall(parsed.id, parsed.call)
    else if (parsed.type === 'play') void gists.play(parsed.answers, parsed.fresh === true)
    else if (parsed.type === 'reroll') gists.reroll()
    else gists.rewatch(parsed.text)
    return
  }
  if (parsed.type === 'launch') {
    const doc = currentDoc
    if (doc && doc.languageId === 'python') void launch(doc)
    return
  }
  if (parsed.type === 'arch') {
    const decider = gistDecider ?? callLog.decider(localDecider())
    void judgeArchitecture(decider, parsed.modules, parsed.shapes)
      .then(({ roles, shape }) => {
        postToAll({ type: 'arched', key: parsed.key, roles, shape })
      })
      .catch(() => undefined)
    return
  }
  if (parsed.type === 'config') {
    const decider = gistDecider ?? callLog.decider(localDecider())
    void judgeConfig(decider, parsed.items)
      .then((kinds) => {
        postToAll({ type: 'configured', key: parsed.key, kinds })
      })
      .catch(() => undefined)
    return
  }
  if (parsed.type === 'cover') {
    // Lo escrito y lo planeado se preguntan por separado: una respuesta no deja vieja a la otra.
    const which = parsed.plan === true ? 'planned' : 'written'
    const turn = ++coverTurns[which]
    const decider = gistDecider ?? callLog.decider(localDecider())
    void judgeCover(decider, parsed.what, parsed.parts, parsed.pieces, parsed.plan === true)
      .then((by) => {
        if (turn !== coverTurns[which]) return
        postToAll({
          type: 'covered',
          parts: parsed.parts,
          pieces: parsed.pieces,
          by,
          ...(parsed.plan === true ? { plan: true } : {}),
        })
      })
      .catch(() => undefined)
    return
  }
  if (parsed.type === 'undoOrder') {
    void undoOrder()
    return
  }
  // Lo que se le está oyendo decir: aquí no hay voz que escuchar.
  if (parsed.type === 'listening') return
  if (parsed.type === 'clearCalls') {
    callLog.clear()
    return
  }
  if (parsed.type === 'spoken') {
    speaking.get(parsed.seq)?.(parsed.spoke)
    speaking.delete(parsed.seq)
    return
  }
  if (parsed.type === 'stopOrder') {
    stopBuild(currentDoc)
    return
  }
  if (parsed.type === 'pickModel') {
    void vscode.commands.executeCommand('prysel.pickModel')
    return
  }
  if (parsed.type === 'jevKey') {
    void vscode.commands.executeCommand('prysel.setTypesafeKey')
    return
  }
  if (parsed.type === 'newLesson') {
    void vscode.commands.executeCommand('prysel.newLesson')
    return
  }
  if (parsed.type === 'proposeSections') {
    void vscode.commands.executeCommand('prysel.proposeSections')
    return
  }
  if (parsed.type === 'undo' || parsed.type === 'redo') {
    void stepHistory(parsed.type)
    return
  }
  if (parsed.type === 'noteMove') {
    const doc = currentDoc
    if (doc && doc.uri.scheme === 'file') void moveNote(doc, parsed.beat, parsed.offset)
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
  // Lo que queda es el aviso de que el lienzo está listo: cualquier otra cosa que no se atienda, se ignora.
  if (parsed.type !== 'ready') return
  webviewsReady++
  postToAll({ type: 'theme', theme: themeKind() })
  void postModels()
  // Un lienzo recién abierto no ha visto las consultas de antes: se le mandan.
  for (const entry of callLog.all()) postToAll({ type: 'call', entry })
  void refresh().then(() => {
    // Un lienzo recién abierto no tiene las imágenes de lo que ya se ejecutó: se le mandan.
    const session = currentDoc ? sessions.get(currentDoc.uri.toString()) : undefined
    for (const { seq, assets } of session?.allAssets() ?? []) {
      postToAll({ type: 'assets', seq, assets })
    }
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
      // Oculto detrás de otra pestaña no se deshace: si no, lo que se le mandara mientras tanto (lo que se
      // decidió, lo que hay que escribir) se perdería, y lo pedido se quedaría sin hacer.
      retainContextWhenHidden: true,
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
    /** Lo último que se le dijo al lienzo: cada decisión y cada frase. */
    said: string[]
    /** Lo último que llegó del lienzo (el tipo de cada mensaje, o que no era válido). */
    heard: string[]
  }
}

/** El documento sobre el que actúan los comandos de ejecución: el activo, si es Python. */
function targetDocument(): vscode.TextDocument | null {
  const doc = vscode.window.activeTextEditor?.document ?? currentDoc
  return doc?.languageId === 'python' ? doc : null
}

export function activate(context: vscode.ExtensionContext): PryselApi {
  extensionContext = context
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
    vscode.commands.registerCommand('prysel.proposeSections', async () => {
      const doc = targetDocument()
      if (!doc || doc.languageId !== 'python') {
        void vscode.window.showInformationMessage(
          'Prysel: abre un archivo de Python para proponer sus etapas con IA.',
        )
        return
      }
      try {
        await proposeFileSections(context, doc)
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Prysel: no se pudieron proponer las etapas. ${messageOf(error)}`,
        )
      }
    }),
    vscode.commands.registerCommand('prysel.explainTopic', async () => {
      try {
        await explainTopic(context)
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Prysel: no se pudo generar el tema. ${messageOf(error)}`,
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
    vscode.commands.registerCommand('prysel.pickModel', async () => {
      await pickModel(context)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('prysel')) void postModels()
    }),
    context.secrets.onDidChange(() => {
      void postModels()
    }),
    vscode.commands.registerCommand('prysel.setDeepseekKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Clave de la API de DeepSeek (platform.deepseek.com)',
        password: true,
        ignoreFocusOut: true,
      })
      if (!key) return
      await context.secrets.store(DEEPSEEK_SECRET, key.trim())
      // Quien guarda esta clave quiere usarla: con «auto» ganaría el modelo de VS Code, si hay uno.
      await vscode.workspace
        .getConfiguration('prysel')
        .update('aiProvider', 'deepseek', vscode.ConfigurationTarget.Global)
      void vscode.window.showInformationMessage(
        'Prysel: clave de DeepSeek guardada. A partir de ahora la IA de Prysel es DeepSeek (ajuste «prysel.aiProvider»).',
      )
    }),
    vscode.commands.registerCommand('prysel.clearDeepseekKey', async () => {
      await context.secrets.delete(DEEPSEEK_SECRET)
      void vscode.window.showInformationMessage('Prysel: clave de DeepSeek borrada.')
    }),
    vscode.commands.registerCommand('prysel.setTypesafeKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Clave de la API de TypeSafe (Jev), para el motor que decide las órdenes',
        password: true,
        ignoreFocusOut: true,
      })
      if (!key) return
      await context.secrets.store(TYPESAFE_SECRET, key.trim())
      void vscode.window.showInformationMessage('Prysel: clave de TypeSafe guardada.')
    }),
    vscode.commands.registerCommand('prysel.clearTypesafeKey', async () => {
      await context.secrets.delete(TYPESAFE_SECRET)
      void vscode.window.showInformationMessage('Prysel: clave de TypeSafe borrada.')
    }),
    vscode.commands.registerCommand('prysel.interrupt', () => {
      const doc = targetDocument()
      if (doc) sessions.get(doc.uri.toString())?.interrupt()
    }),
    vscode.commands.registerCommand('prysel.restart', () => {
      const doc = targetDocument()
      if (doc) sessions.get(doc.uri.toString())?.restart()
    }),
    // «Prysel: Pedir…»: lo que se escribe aquí llega al lienzo como si se hubiera tecleado en él (y, si no
    // está abierto, se abre). Las pruebas lo usan con el texto ya dado.
    vscode.commands.registerCommand('prysel.ask', async (given?: unknown) => {
      const text =
        typeof given === 'string' && given.trim() !== ''
          ? given
          : await vscode.window.showInputBox({
              prompt: 'Prysel: ¿qué quieres construir o cambiar?',
              placeHolder: 'Un piano que suene, un juego de adivinar un número…',
            })
      if (!text?.trim()) return
      // El lienzo, a la vista: es donde se va a ver construirse.
      if (panel && !panel.visible) panel.reveal(vscode.ViewColumn.Beside, true)
      if (webviewsReady === 0 || webviews.size === 0) {
        const before = webviewsReady
        await vscode.commands.executeCommand('prysel.openCanvas')
        const until = Date.now() + 15_000
        while (webviewsReady === before && Date.now() < until) await sleep(100)
      }
      postToAll({ type: 'ask', text: text.trim().slice(0, MAX_COMMAND) })
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
        said: [...saidLog],
        heard: [...heardLog],
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
