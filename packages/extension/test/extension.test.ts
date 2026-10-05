import { spawnSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * El cableado de la extensión con una API de VS Code simulada: abrir el lienzo, responder al
 * «ready», ejecutar, resolver el intérprete y negarse a ejecutar sin confianza. No es un VS Code
 * real —no comprueba la API de verdad—, pero ejercita `extension.ts` de punta a punta con un Python real.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0

interface Posted {
  type: string
  [key: string]: unknown
}

const state = vi.hoisted(() => ({
  trusted: true,
  configuredPython: '',
  pythonExtension: undefined as unknown,
  commands: new Map<string, () => unknown>(),
  posted: [] as { type: string; [key: string]: unknown }[],
  onMessage: null as null | ((message: unknown) => void),
  warnings: [] as string[],
  document: null as unknown,
  closeListeners: [] as ((doc: unknown) => void)[],
  editorListeners: [] as ((editor: unknown) => void)[],
  /** Los archivos que «hay en el disco» (por su ruta): los guiones de lección. */
  files: new Map<string, string>(),
  watchers: [] as (() => void)[],
  /** Cada prueba carga la extensión de nuevo: lo que publica una anterior no cuenta. */
  epoch: 0,
}))

vi.mock('vscode', () => {
  const uri = (path: string) => ({ fsPath: path, path, toString: () => `file:///${path}` })
  return {
    Uri: {
      file: (path: string) => uri(path),
      joinPath: (base: { path: string }, ...parts: string[]) =>
        uri([base.path, ...parts].join('/')),
    },
    ViewColumn: { Beside: 2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    // Solo se construyen al aplicar ediciones del lienzo, que estas pruebas no ejercitan.
    Range: function Range() {},
    WorkspaceEdit: function WorkspaceEdit() {},
    commands: {
      registerCommand: (id: string, callback: () => unknown) => {
        state.commands.set(id, callback)
        return { dispose() {} }
      },
    },
    extensions: { getExtension: () => state.pythonExtension },
    window: {
      get activeTextEditor() {
        return state.document ? { document: state.document } : undefined
      },
      activeColorTheme: { kind: 2 },
      registerWebviewViewProvider: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: (listener: (editor: unknown) => void) => {
        state.editorListeners.push(listener)
        return { dispose() {} }
      },
      onDidChangeActiveColorTheme: () => ({ dispose() {} }),
      showWarningMessage: (text: string) => {
        state.warnings.push(text)
        return Promise.resolve(undefined)
      },
      showErrorMessage: () => Promise.resolve(undefined),
      createWebviewPanel: () => {
        const mine = state.epoch
        return {
          webview: {
            html: '',
            cspSource: 'csp',
            asWebviewUri: (u: unknown) => u,
            onDidReceiveMessage: (callback: (message: unknown) => void) => {
              state.onMessage = callback
              return { dispose() {} }
            },
            postMessage: (message: { type: string }) => {
              if (mine === state.epoch) state.posted.push(message)
              return Promise.resolve(true)
            },
          },
          onDidDispose: () => ({ dispose() {} }),
          reveal() {},
        }
      },
    },
    workspace: {
      get isTrusted() {
        return state.trusted
      },
      getConfiguration: () => ({ get: () => state.configuredPython }),
      getWorkspaceFolder: () => undefined,
      onDidChangeTextDocument: () => ({ dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidCloseTextDocument: (listener: (doc: unknown) => void) => {
        state.closeListeners.push(listener)
        return { dispose() {} }
      },
      applyEdit: () => Promise.resolve(true),
      textDocuments: [],
      fs: {
        readFile: (target: { path: string }) => {
          const text = state.files.get(target.path)
          return text === undefined
            ? Promise.reject(new Error('FileNotFound'))
            : Promise.resolve(new TextEncoder().encode(text))
        },
      },
      createFileSystemWatcher: () => ({
        onDidChange: (listener: () => void) => {
          state.watchers.push(listener)
          return { dispose() {} }
        },
        onDidCreate: (listener: () => void) => {
          state.watchers.push(listener)
          return { dispose() {} }
        },
        onDidDelete: (listener: () => void) => {
          state.watchers.push(listener)
          return { dispose() {} }
        },
        dispose() {},
      }),
    },
  }
})

const SOURCE = 'a = 2\nb = a * 21\nprint(b)\n'

// El motor arranca en la carpeta del archivo: tiene que existir.
const HERE = process.cwd().split('\\').join('/')

const fakeDocument = (version = 1) => ({
  languageId: 'python',
  fileName: `${HERE}/demo.py`,
  version,
  uri: { scheme: 'file', fsPath: `${HERE}/demo.py`, toString: () => `file:///${HERE}/demo.py` },
  getText: () => SOURCE,
})

const wait = async (condition: () => boolean, ms = 15_000) => {
  const until = Date.now() + ms
  while (!condition()) {
    if (Date.now() > until) throw new Error('se agotó la espera')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const last = (type: string): Posted | undefined =>
  [...state.posted].reverse().find((message) => message.type === type)

describe.skipIf(!available)('la extensión con una API de VS Code simulada', () => {
  let deactivate: () => void

  beforeEach(async () => {
    state.epoch++
    state.trusted = true
    state.configuredPython = python
    state.pythonExtension = undefined
    state.posted.length = 0
    state.warnings.length = 0
    state.commands.clear()
    state.editorListeners.length = 0
    state.closeListeners.length = 0
    state.files.clear()
    state.watchers.length = 0
    state.document = fakeDocument()
    vi.resetModules()
    const extension = await import('../src/extension.ts')
    deactivate = extension.deactivate
    extension.activate({
      subscriptions: [],
      extensionUri: { path: '/ext', fsPath: '/ext' },
      // Sin claves guardadas: no hay IA ni motor JEV, y el lienzo lo dice.
      secrets: {
        get: () => Promise.resolve(undefined),
        onDidChange: () => ({ dispose() {} }),
      },
    } as never)
    await state.commands.get('prysel.openCanvas')?.()
    // El webview avisa de que está listo: la extensión responde con el tema, el programa y el estado.
    state.onMessage?.({ type: 'ready' })
    await wait(() => last('runs') !== undefined)
  })

  it('al abrir el lienzo manda el programa y el estado de cada sentencia, sin ejecutar nada', () => {
    const update = last('update') as Posted & { version: number; program: { nodes: unknown[] } }
    expect(update.version).toBe(1)
    expect(update.program.nodes.length).toBeGreaterThan(0)
    const runs = last('runs') as Posted & {
      views: Record<string, { state: string }>
      kernel: string
    }
    expect(runs.kernel).toBe('stopped')
    expect(Object.values(runs.views).map((v) => v.state)).toEqual(['never', 'never', 'never'])
    deactivate()
  })

  it('ejecutar todo arranca el motor, deja las sentencias al día y avisa de cada cambio', async () => {
    state.onMessage?.({ type: 'run', version: 1, ids: 'all' })
    await wait(() => {
      const runs = last('runs') as (Posted & { kernel: string }) | undefined
      return runs?.kernel === 'idle'
    })
    const runs = last('runs') as Posted & {
      views: Record<string, { state: string; stdout?: string }>
    }
    expect(Object.values(runs.views).map((v) => v.state)).toEqual(['fresh', 'fresh', 'fresh'])
    expect(Object.values(runs.views).at(-1)?.stdout).toBe('42\n')
    // Pasó por «arrancando» y «ocupado» antes de quedar libre.
    const kernels = state.posted.filter((m) => m.type === 'runs').map((m) => m['kernel'])
    expect(kernels).toContain('starting')
    expect(kernels).toContain('busy')
    deactivate()
  })

  it('una petición calculada sobre un texto que ya cambió se descarta y no ejecuta nada', async () => {
    // En VS Code el documento es el mismo objeto y su versión sube al teclear.
    ;(state.document as { version: number }).version = 2
    state.onMessage?.({ type: 'run', version: 1, ids: 'all' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const runs = last('runs') as Posted & { kernel: string }
    expect(runs.kernel).toBe('stopped')
    deactivate()
  })

  it('sin confianza en el espacio de trabajo no ejecuta, y lo dice', async () => {
    state.trusted = false
    state.onMessage?.({ type: 'run', version: 1, ids: 'all' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(state.warnings.join(' ')).toMatch(/confiar/)
    expect((last('runs') as Posted & { kernel: string }).kernel).toBe('stopped')
    deactivate()
  })

  it('sin `prysel.python`, usa el entorno que eligió el usuario en la extensión de Python', async () => {
    state.configuredPython = ''
    const asked: string[] = []
    state.pythonExtension = {
      activate: () =>
        Promise.resolve({
          environments: {
            getActiveEnvironmentPath: () => ({ path: 'entorno' }),
            resolveEnvironment: (environment: { path: string }) => {
              asked.push(environment.path)
              return Promise.resolve({ executable: { uri: { scheme: 'file', fsPath: python } } })
            },
          },
        }),
    }
    state.onMessage?.({ type: 'run', version: 1, ids: 'all' })
    await wait(() => (last('runs') as (Posted & { kernel: string }) | undefined)?.kernel === 'idle')
    expect(asked).toEqual(['entorno'])
    deactivate()
  })

  describe('la lección del archivo', () => {
    const LESSON_PATH = `${HERE}/demo.lesson.json`
    const GOOD = JSON.stringify({
      version: 1,
      title: 'Demo',
      beats: [{ at: { text: 'a = 2' }, note: { text: 'Empieza aquí.' } }],
    })
    type LessonPosted = Posted & { file: string; lesson: { title: string } | null; error?: string }

    it('sin guion junto al programa, avisa de que no hay lección', () => {
      const lesson = last('lesson') as LessonPosted
      expect(lesson.file).toBe('demo.py')
      expect(lesson.lesson).toBeNull()
      expect(lesson.error).toBeUndefined()
      deactivate()
    })

    it('con un `.lesson.json` al lado, manda la lección al lienzo, y la sigue cuando cambia el archivo', async () => {
      state.files.set(LESSON_PATH, GOOD)
      for (const changed of state.watchers) changed()
      await wait(() => (last('lesson') as LessonPosted | undefined)?.lesson?.title === 'Demo')
      state.files.set(LESSON_PATH, GOOD.replace('Demo', 'Otra'))
      for (const changed of state.watchers) changed()
      await wait(() => (last('lesson') as LessonPosted | undefined)?.lesson?.title === 'Otra')
      state.files.delete(LESSON_PATH)
      for (const changed of state.watchers) changed()
      await wait(() => (last('lesson') as LessonPosted | undefined)?.lesson === null)
      deactivate()
    })

    it('un guion roto no rompe el lienzo: llega el motivo', async () => {
      state.files.set(LESSON_PATH, '{ "version": 1, ')
      for (const changed of state.watchers) changed()
      await wait(() => (last('lesson') as LessonPosted | undefined)?.error !== undefined)
      const lesson = last('lesson') as LessonPosted
      expect(lesson.lesson).toBeNull()
      expect(lesson.error).toMatch(/JSON/)
      // El diagrama sigue ahí.
      expect(state.posted.some((m) => m.type === 'update' && m['program'] === null)).toBe(false)
      deactivate()
    })

    it('abrir el guion en un editor no cambia el programa que se enseña', async () => {
      const lessonDoc = {
        languageId: 'json',
        fileName: LESSON_PATH,
        version: 1,
        uri: { scheme: 'file', fsPath: LESSON_PATH, toString: () => `file:///${LESSON_PATH}` },
        getText: () => GOOD,
      }
      state.document = lessonDoc
      state.posted.length = 0
      for (const listener of state.editorListeners) listener({ document: lessonDoc })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(state.posted.some((m) => m.type === 'update')).toBe(false)
      deactivate()
    })
  })

  it('pasar el foco al propio lienzo (sin editor de texto) no vacía el diagrama', async () => {
    // En VS Code, al pulsar sobre un webview `activeTextEditor` pasa a ser `undefined`.
    state.posted.length = 0
    for (const listener of state.editorListeners) listener(undefined)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(state.posted.some((m) => m.type === 'update' && m['program'] === null)).toBe(false)
    // Y ejecutar sigue actuando sobre el mismo archivo.
    await state.commands.get('prysel.runAll')?.()
    const runs = last('runs') as Posted & { kernel: string }
    expect(runs.kernel).toBe('idle')
    deactivate()
  })

  it('cambiar a otro editor de texto sí cambia lo que se enseña', async () => {
    const other = {
      ...fakeDocument(),
      fileName: `${HERE}/otro.py`,
      uri: { scheme: 'file', fsPath: `${HERE}/otro.py`, toString: () => `file:///${HERE}/otro.py` },
      getText: () => 'z = 1\n',
    }
    state.document = other
    state.posted.length = 0
    for (const listener of state.editorListeners) listener({ document: other })
    await wait(() => last('update') !== undefined)
    expect((last('update') as Posted & { file: string }).file).toBe('otro.py')
    deactivate()
  })

  it('un intérprete que no existe deja el motivo a la vista en vez de romper', async () => {
    state.configuredPython = 'python-que-no-existe-prysel'
    state.onMessage?.({ type: 'run', version: 1, ids: 'all' })
    await wait(() => (last('runs') as (Posted & { kernel: string }) | undefined)?.kernel === 'dead')
    expect((last('runs') as Posted & { problem: string | null }).problem).toBeTruthy()
    deactivate()
  })

  it('reiniciar vuelve todo a «sin ejecutar»; cerrar el documento libera su motor', async () => {
    state.onMessage?.({ type: 'run', version: 1, ids: 'all' })
    await wait(() => (last('runs') as (Posted & { kernel: string }) | undefined)?.kernel === 'idle')
    state.onMessage?.({ type: 'restart' })
    await wait(
      () => (last('runs') as (Posted & { kernel: string }) | undefined)?.kernel === 'stopped',
    )
    const runs = last('runs') as Posted & { views: Record<string, { state: string }> }
    expect(Object.values(runs.views).every((v) => v.state === 'never')).toBe(true)
    for (const listener of state.closeListeners) listener(state.document)
    deactivate()
  })

  it('los mensajes mal formados se ignoran: no ejecutan nada', async () => {
    for (const bad of [
      { type: 'run' },
      { type: 'run', version: 1, ids: [] },
      'run',
      null,
      { type: 'rm -rf' },
    ]) {
      state.onMessage?.(bad)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((last('runs') as Posted & { kernel: string }).kernel).toBe('stopped')
    deactivate()
  })
})
