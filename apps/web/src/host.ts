import { buildProgram, createPythonParser, type Program, type PythonParser } from '@prysel/python'
import { validEdits, type TextEdit } from '@prysel/python/edits'
import runtimeWasm from '@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm?url'
import pythonWasm from '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm?url'
import { CallLog } from '../../../packages/extension/src/calls.ts'
import { recorder } from './recorder.ts'
import { EditHistory } from '../../../packages/extension/src/history.ts'
import { moveNoteIn, readLesson, type Lesson } from '../../../packages/extension/src/lesson.ts'
import {
  parseHostMessage,
  type HostMessage,
  type Theme,
  type WebviewMessage,
} from '../../../packages/extension/src/protocol.ts'
import { Session } from '../../../packages/extension/src/session.ts'
import { WebKernel } from './engine.ts'
import { Orders } from './orders.ts'
import {
  deciderFrom,
  loadFlow,
  loadSettings,
  providerFrom,
  saveSettings,
  type AiSettings,
} from './settings.ts'

/**
 * El anfitrión del lienzo en la web: hace lo que en VS Code hace la extensión (`extension.ts`), pero en la
 * propia página. El lienzo es el mismo webview, sin cambios: le habla por mensajes (`protocol.ts`) y no
 * sabe que al otro lado no hay un editor sino esto.
 *
 * El documento vive aquí (texto, versión y guion de lección): lo cambian el editor de código de la web
 * y las ediciones que llegan del lienzo; cada cambio se vuelve a analizar y se manda al lienzo.
 */

export interface WebDocument {
  /** El nombre que se enseña (`factorial.py`). */
  name: string
  text: string
  /** El guion de la lección (`.lesson.json`), si lo tiene. */
  lesson: string | null
}

type Listener = (doc: WebDocument & { version: number }) => void

/** Lo que el lienzo le pide a la página y no es del documento: abrir los ajustes de la IA. */
export type ShellRequest = 'settings'

/** Quién cambió el código: una orden a la IA, el lienzo, el editor de código, deshacer, u otro documento. */
type ChangeBy = 'orden' | 'lienzo' | 'editor' | 'deshacer' | 'documento'

interface CodeChange {
  at: string
  /** Milisegundos desde que se abrió la página. */
  ms: number
  version: number
  by: ChangeBy
  file: string
  /** Lo que cambió: en qué línea, qué se quitó y qué se puso. Vacío si el texto cambió entero. */
  edits: { line: number; removed: string; added: string }[]
  /** El código entero, tal como quedó. */
  after: string
}

/** Cuántos cambios se recuerdan. */
const MAX_CHANGES = 600

export class WebHost {
  private doc: WebDocument = { name: 'programa.py', text: '', lesson: null }
  private version = 1
  private parser: PythonParser | null = null
  private parserReady: Promise<PythonParser>
  private history = new EditHistory()
  private session: Session
  private ready = false
  private listeners = new Set<Listener>()
  private theme: Theme = 'light'
  private requests = new Set<(request: ShellRequest) => void>()
  private settings: AiSettings = loadSettings()
  private calls = new CallLog((entry) => this.post({ type: 'call', entry }))
  /** Cada cambio que se le ha hecho al código desde que se abrió la página. */
  private changes: CodeChange[] = []
  /** Cuánto había en la historia de deshacer al empezar cada orden. */
  private marks: number[] = []
  private started = performance.now()
  private orders: Orders

  constructor() {
    this.parserReady = createPythonParser({ runtime: runtimeWasm, language: pythonWasm }).then(
      (parser) => (this.parser = parser),
    )
    this.session = this.newSession()
    this.orders = new Orders({
      version: () => this.version,
      text: () => this.doc.text,
      name: () => this.doc.name,
      parser: () => this.parserReady,
      analyse: () => this.analyse(),
      write: (edits, remember = true) => this.writeFrom(edits, remember),
      refresh: () => this.refresh(),
      post: (message) => this.post(message),
      flow: () => loadFlow(),
      provider: () => {
        const provider = providerFrom(this.settings)
        return provider ? this.calls.provider(provider) : null
      },
      decider: () =>
        this.calls.decider(
          deciderFrom(this.settings, () =>
            this.post({
              type: 'say',
              text:
                'No pude conectar con TypeSafe desde el navegador (su API no admite llamadas desde ' +
                'páginas web). Decido con el motor local; para usar TypeSafe, pon un intermediario en Ajustes.',
            }),
          ),
        ),
      trace: () => this.session.trace(this.doc.text),
      setLesson: (lesson: Lesson) => {
        this.doc = { ...this.doc, lesson: JSON.stringify(lesson, null, 2) }
        this.notify()
        this.postLesson()
      },
    })
  }

  private newSession(): Session {
    return new Session(
      () => WebKernel.start(),
      (change) => {
        if (change.type === 'assets') {
          this.post({ type: 'assets', seq: change.seq, assets: change.assets })
        } else {
          this.postRuns()
        }
      },
    )
  }

  // ── lo que usa la página ────────────────────────────────────────────────

  get current(): WebDocument & { version: number } {
    return { ...this.doc, version: this.version }
  }

  /** Avisa de cada cambio del documento (también de los que llegan desde el lienzo). */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** El lienzo pide algo a la página (abrir los ajustes). */
  onRequest(listener: (request: ShellRequest) => void): () => void {
    this.requests.add(listener)
    return () => this.requests.delete(listener)
  }

  get aiSettings(): AiSettings {
    return { ...this.settings }
  }

  setAiSettings(settings: AiSettings) {
    this.settings = { ...settings }
    saveSettings(this.settings)
    this.postModels()
  }

  private postModels() {
    const provider = providerFrom(this.settings)
    this.post({ type: 'models', ai: provider?.id ?? null, jev: deciderFrom(this.settings).id })
  }

  /** Abre otro documento: se olvida lo ejecutado y la historia del anterior. */
  open(doc: WebDocument) {
    this.orders.reset()
    this.session.dispose()
    this.session = this.newSession()
    this.history.clear()
    const before = this.doc.text
    this.doc = { ...doc }
    this.version++
    this.noteChange('documento', before)
    void this.refresh()
  }

  /** El usuario escribió en el editor de código. */
  setText(text: string) {
    if (text === this.doc.text) return
    const before = this.doc.text
    this.doc = { ...this.doc, text }
    this.version++
    this.noteChange('editor', before)
    void this.refresh()
  }

  setTheme(theme: Theme) {
    this.theme = theme
    if (this.ready) this.post({ type: 'theme', theme })
  }

  // ── el canal con el lienzo ──────────────────────────────────────────────

  /** Lo que manda el lienzo (su `vscode.postMessage`). Se valida igual que en la extensión. */
  receive(value: unknown) {
    const message = parseHostMessage(value)
    if (message) {
      recorder.note('in', message)
      void this.handle(message)
    }
  }

  private post(message: WebviewMessage) {
    recorder.note('out', message)
    // Como un `postMessage` de verdad: llega después, nunca dentro de la llamada que lo provocó.
    setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: message })), 0)
  }

  private async handle(message: HostMessage) {
    switch (message.type) {
      case 'ready':
        this.ready = true
        this.post({ type: 'theme', theme: this.theme })
        this.postModels()
        for (const entry of this.calls.all()) this.post({ type: 'call', entry })
        await this.refresh()
        return
      case 'edit':
        return this.applyEdits(message.edits, message.version)
      case 'undo':
      case 'redo':
        return this.stepHistory(message.type)
      case 'run':
        if (message.version !== this.version) return void this.refresh()
        void this.session.run(message.ids)
        return
      case 'trace':
        if (message.version !== this.version) return void this.refresh()
        return this.traceDocument()
      case 'interrupt':
        this.session.interrupt()
        return
      case 'restart':
        this.session.restart()
        return
      case 'noteMove': {
        if (!this.doc.lesson) return
        const next = moveNoteIn(this.doc.lesson, message.beat, message.offset)
        if (next === null || next === this.doc.lesson) return
        this.doc = { ...this.doc, lesson: next }
        this.notify()
        this.postLesson()
        return
      }
      case 'command':
        // Dónde estaba la historia al empezar esta orden: «no, eso no» vuelve justo hasta aquí.
        this.marks.push(this.history.sizes.undo)
        if (this.marks.length > 40) this.marks.shift()
        void this.orders.receive(message)
        return
      case 'undoOrder': {
        this.orders.stop()
        const sizes = () => this.history.sizes.undo
        // La última orden que de verdad escribió algo (las que solo miraron no dejaron nada que deshacer).
        let to = this.marks.pop()
        while (to !== undefined && to >= sizes() && this.marks.length > 0) to = this.marks.pop()
        const floor = to === undefined || to >= sizes() ? Math.max(0, sizes() - 1) : to
        while (sizes() > floor) {
          const before = sizes()
          await this.stepHistory('undo')
          if (sizes() >= before) break
        }
        return
      }
      case 'spoken':
        this.orders.spoken(message.seq, message.spoke)
        return
      case 'stopOrder':
        this.orders.stop()
        return
      case 'listening':
        this.orders.listening(message.on, message.text)
        return
      case 'clearCalls':
        this.calls.clear()
        return
      case 'pickModel':
      case 'jevKey':
        for (const listener of this.requests) listener('settings')
        return
      default:
        // Lo demás (claves, selector de modelos, etapas con IA…) llega en fases siguientes.
        return
    }
  }

  // ── el documento ────────────────────────────────────────────────────────

  private notify() {
    const snapshot = this.current
    for (const listener of this.listeners) listener(snapshot)
  }

  private async refresh() {
    this.notify()
    if (!this.ready) return
    const parser = this.parser ?? (await this.parserReady)
    const version = this.version
    const text = this.doc.text
    let program: Program | null = null
    try {
      program = buildProgram(parser.parse(text), text)
      this.session.update(program, text)
      this.orders.tend(program)
    } catch {
      // El código a medio escribir no debe tumbar el lienzo.
      program = null
    }
    // Mientras se analizaba llegó otra versión: esta ya no vale.
    if (version !== this.version) return
    this.post({ type: 'update', program, file: this.doc.name, version })
    this.postRuns()
    this.post({ type: 'history', ...this.history.sizes })
    this.postLesson()
  }

  private postRuns() {
    this.post({
      type: 'runs',
      views: this.session.views(),
      kernel: this.session.status,
      problem: this.session.problem,
      version: this.version,
    })
  }

  private postLesson() {
    const file = this.doc.name
    if (!this.doc.lesson) return this.post({ type: 'lesson', file, lesson: null })
    const result = readLesson(this.doc.lesson)
    this.post(
      result.ok
        ? { type: 'lesson', file, lesson: result.lesson }
        : { type: 'lesson', file, lesson: null, error: result.error },
    )
  }

  private async analyse(): Promise<Program> {
    const parser = await this.parserReady
    return buildProgram(parser.parse(this.doc.text), this.doc.text)
  }

  /** Una edición que llega de una orden (no del lienzo): se aplica y se apunta en la historia. */
  private writeFrom(edits: readonly TextEdit[], remember: boolean): boolean {
    if (!validEdits(edits, this.doc.text.length)) return false
    const before = this.doc.text
    this.write(edits, 'orden')
    if (remember) this.history.applied(before, edits, this.version)
    this.notify()
    return true
  }

  private write(edits: readonly TextEdit[], by: ChangeBy = 'lienzo') {
    const before = this.doc.text
    let text = before
    // Se aplican de atrás adelante: así los desplazamientos de las primeras siguen valiendo.
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
    }
    this.doc = { ...this.doc, text }
    this.version++
    this.noteChange(by, before, edits)
  }

  /** Apunta un cambio al código: quién lo hizo, qué líneas tocó y cómo quedó. */
  private noteChange(by: ChangeBy, before: string, edits: readonly TextEdit[] = []) {
    const lineOf = (offset: number) => before.slice(0, offset).split('\n').length
    this.changes.push({
      at: new Date().toISOString(),
      ms: Math.round(performance.now() - this.started),
      version: this.version,
      by,
      file: this.doc.name,
      edits: [...edits]
        .sort((a, b) => a.start - b.start)
        .map((edit) => ({
          line: lineOf(edit.start),
          removed: before.slice(edit.start, edit.end),
          added: edit.text,
        })),
      after: this.doc.text,
    })
    if (this.changes.length > MAX_CHANGES) this.changes.splice(0, this.changes.length - MAX_CHANGES)
  }

  /** Si hay algo en marcha: una orden construyendo, o una consulta a un modelo sin contestar. */
  get busy(): boolean {
    return this.orders.busy || this.calls.all().some((call) => call.status === 'running')
  }

  /** Todo lo que se le ha preguntado a cada modelo y lo que contestó, para descargarlo. Sin claves. */
  callsLog(): unknown {
    return {
      what: 'Prysel · consultas a los modelos',
      at: new Date().toISOString(),
      file: this.doc.name,
      calls: this.calls.all(),
    }
  }

  /** Cada cambio que se le ha hecho al código, en orden, con cómo quedó tras cada uno. */
  changesLog(): unknown {
    return {
      what: 'Prysel · cambios al código',
      at: new Date().toISOString(),
      file: this.doc.name,
      now: this.doc.text,
      changes: this.changes,
    }
  }

  private async applyEdits(edits: TextEdit[], version: number) {
    if (version !== this.version || !validEdits(edits, this.doc.text.length)) {
      return this.refresh()
    }
    const before = this.doc.text
    this.write(edits)
    this.history.applied(before, edits, this.version)
    // Lo que el lienzo acaba de escribir es «lo último que se hizo»: una orden puede referirse a ello.
    const first = [...edits].sort((a, b) => a.start - b.start)[0]
    if (first) {
      const from =
        before.slice(0, first.start).split('\n').length + (first.text.startsWith('\n') ? 1 : 0)
      const added = first.text.replace(/^\r?\n|\r?\n$/g, '').split('\n').length
      this.orders.touched(from, from + Math.max(0, added - 1))
    }
    await this.refresh()
  }

  private async stepHistory(direction: 'undo' | 'redo') {
    const edits =
      direction === 'undo'
        ? this.history.nextUndo(this.version)
        : this.history.nextRedo(this.version)
    if (!edits) return this.post({ type: 'history', ...this.history.sizes })
    const before = this.doc.text
    if (!validEdits(edits, before.length)) {
      this.history.clear()
      return this.post({ type: 'history', ...this.history.sizes })
    }
    this.write(edits, 'deshacer')
    if (direction === 'undo') this.history.undone(before, this.version)
    else this.history.redone(before, this.version)
    await this.refresh()
  }

  private async traceDocument() {
    const version = this.version
    this.post({ type: 'trace', version, status: 'running', trace: null })
    const trace = await this.session.trace(this.doc.text)
    if (trace) {
      this.post({ type: 'trace', version, status: 'done', trace })
    } else {
      const problem = this.session.problem ?? 'No se pudo grabar la traza.'
      this.post({ type: 'trace', version, status: 'failed', trace: null, message: problem })
    }
  }
}
