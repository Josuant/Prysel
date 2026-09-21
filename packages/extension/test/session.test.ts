import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser } from '@prysel/python'
import { Kernel } from '../src/kernel.ts'
import { describeSummary } from '../src/runs.ts'
import { Session, type SessionChange } from '../src/session.ts'

/**
 * La sesión de ejecución con un Python de verdad: qué corre al pedir un nodo, qué queda desactualizado
 * tras editar, y cómo se comporta ante un error, una interrupción o un motor que muere.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const works = (code: string) => spawnSync(python, ['-c', code], { stdio: 'ignore' }).status === 0
const available = works('import sys')
const withMatplotlib = available && works('import matplotlib')

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => ReturnType<typeof buildProgram>

beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source) => buildProgram(parser.parse(source), source)
}, 30_000)

describe.skipIf(!available)('una sesión de ejecución', () => {
  const sessions: Session[] = []
  const open = (source: string) => {
    const changes: SessionChange[] = []
    const session = new Session(
      () => Kernel.start({ python }),
      (change) => changes.push(change),
    )
    sessions.push(session)
    const program = parse(source)
    session.update(program, source)
    return { session, changes, program }
  }
  /** Las vistas por línea de la sentencia, para leerlas de un vistazo. */
  const byLine = (session: Session, source: string) => {
    const program = parse(source)
    const views = session.views()
    return Object.fromEntries(
      program.nodes.flatMap((node) => {
        const view = views[node.id]
        return view ? [[node.line, view]] : []
      }),
    )
  }
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose()
  })

  const SOURCE = 'a = 2\nb = a * 10\nc = [b, b + 1]\nd = "libre"\n'

  it('antes de ejecutar nada, todo está sin ejecutar y el motor parado', () => {
    const { session } = open(SOURCE)
    expect(session.status).toBe('stopped')
    expect(Object.values(session.views()).map((v) => v.state)).toEqual([
      'never',
      'never',
      'never',
      'never',
    ])
  })

  it('ejecutar todo deja cada sentencia al día, con el resumen de lo que definió', async () => {
    const { session } = open(SOURCE)
    await session.run('all')
    const views = byLine(session, SOURCE)
    expect(Object.values(views).map((v) => v.state)).toEqual(['fresh', 'fresh', 'fresh', 'fresh'])
    expect(views[2]?.values?.['b']).toMatchObject({ type: 'int', repr: '20' })
    expect(views[3]?.values?.['c']).toMatchObject({ type: 'list', length: 2 })
    expect(session.status).toBe('idle')
  })

  it('pedir un nodo ejecuta antes lo que necesita, y nada más', async () => {
    const { session, program } = open(SOURCE)
    const c = program.nodes.find((n) => n.line === 3)
    await session.run([c?.id ?? ''])
    const states = Object.values(byLine(session, SOURCE)).map((v) => v.state)
    // `a`, `b` y `c`; `d` no tiene nada que ver.
    expect(states).toEqual(['fresh', 'fresh', 'fresh', 'never'])
  })

  it('editar deja desactualizado lo que depende de lo editado, y volver a pedir lo actualiza', async () => {
    const { session } = open(SOURCE)
    await session.run('all')
    const edited = 'a = 3\nb = a * 10\nc = [b, b + 1]\nd = "libre"\n'
    const program = parse(edited)
    session.update(program, edited)
    expect(Object.values(byLine(session, edited)).map((v) => v.state)).toEqual([
      'never',
      'stale',
      'stale',
      'fresh',
    ])
    // Pedir `c` trae `a` y `b`, que hacen falta; `d` sigue como estaba.
    const c = program.nodes.find((n) => n.line === 3)
    await session.run([c?.id ?? ''])
    const views = byLine(session, edited)
    expect(Object.values(views).map((v) => v.state)).toEqual(['fresh', 'fresh', 'fresh', 'fresh'])
    expect(views[2]?.values?.['b']).toMatchObject({ repr: '30' })
  })

  it('un error detiene lo que quedaba, señala su línea en el archivo y deja lo anterior', async () => {
    const source = 'a = 1\nb = 2\nc = a / 0\nd = 4\n'
    const { session } = open(source)
    await session.run('all')
    const views = byLine(session, source)
    expect(views[3]?.state).toBe('error')
    expect(views[3]?.error).toMatchObject({ name: 'ZeroDivisionError', line: 3 })
    expect(views[1]?.state).toBe('fresh')
    // `d` no llegó a ejecutarse.
    expect(views[4]?.state).toBe('never')
  })

  it('el error de una línea dentro de una sentencia de varias señala la línea real', async () => {
    const source = 'x = 1\nfor i in range(3):\n    y = 10\n    z = i / 0\n'
    const { session } = open(source)
    await session.run('all')
    expect(byLine(session, source)[2]?.error).toMatchObject({ name: 'ZeroDivisionError', line: 4 })
  })

  it('editar lo que falló lo devuelve a «sin ejecutar»; corregirlo y ejecutar, a «al día»', async () => {
    const source = 'a = 1\nb = a / 0\n'
    const { session } = open(source)
    await session.run('all')
    expect(byLine(session, source)[2]?.state).toBe('error')
    const fixed = 'a = 1\nb = a / 1\n'
    session.update(parse(fixed), fixed)
    expect(byLine(session, fixed)[2]?.state).toBe('never')
    await session.run('all')
    expect(byLine(session, fixed)[2]?.state).toBe('fresh')
  })

  it('insertar una línea encima no pierde lo ejecutado', async () => {
    const { session } = open(SOURCE)
    await session.run('all')
    const moved = `import os\n${SOURCE}`
    session.update(parse(moved), moved)
    const states = Object.values(byLine(session, moved)).map((v) => v.state)
    expect(states).toEqual(['never', 'fresh', 'fresh', 'fresh', 'fresh'])
  })

  it('una interrupción corta lo que corre y no ejecuta el resto', async () => {
    const source = 'import time\nwhile True:\n    time.sleep(0.01)\nx = 1\n'
    const { session } = open(source)
    const running = session.run('all')
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(session.status).toBe('busy')
    session.interrupt()
    await running
    const views = byLine(session, source)
    expect(views[2]?.state).toBe('error')
    expect(views[2]?.error?.name).toBe('KeyboardInterrupt')
    expect(views[4]?.state).toBe('never')
    expect(session.status).toBe('idle')
  }, 20_000)

  it('reiniciar pierde todo y el motor vuelve a arrancar al pedir', async () => {
    const { session } = open(SOURCE)
    await session.run('all')
    session.restart()
    expect(session.status).toBe('stopped')
    expect(Object.values(session.views()).every((v) => v.state === 'never')).toBe(true)
    await session.run('all')
    expect(Object.values(session.views()).every((v) => v.state === 'fresh')).toBe(true)
  })

  it('si el motor muere, lo dice, olvida lo ejecutado y se recupera al pedir otra vez', async () => {
    const source = 'a = 1\nimport os\nos._exit(3)\nb = 2\n'
    const { session } = open(source)
    await session.run('all')
    expect(session.status).toBe('dead')
    expect(session.problem).toBeTruthy()
    expect(Object.values(session.views()).every((v) => v.state === 'never')).toBe(true)
    const fixed = 'a = 1\nb = 2\n'
    session.update(parse(fixed), fixed)
    await session.run('all')
    expect(session.status).toBe('idle')
    expect(session.problem).toBeNull()
  })

  it('un intérprete que no arranca deja el motivo en vez de colgarse', async () => {
    const session = new Session(
      () => Kernel.start({ python: 'python-que-no-existe-prysel' }),
      () => undefined,
    )
    sessions.push(session)
    session.update(parse('a = 1\n'), 'a = 1\n')
    await session.run('all')
    expect(session.status).toBe('dead')
    expect(session.problem).toBeTruthy()
  })

  it('las peticiones se encolan: una segunda no pisa a la primera', async () => {
    const source = 'import time\ntime.sleep(0.3)\na = 1\nb = a + 1\n'
    const { session, program } = open(source)
    const b = program.nodes.find((n) => n.line === 4)
    const first = session.run('all')
    const second = session.run([b?.id ?? ''])
    await Promise.all([first, second])
    expect(byLine(session, source)[4]?.values?.['b']).toMatchObject({ repr: '2' })
  })

  it('la salida de una sentencia y su duración quedan con ella', async () => {
    const source = 'print("hola")\nx = 1\n'
    const { session } = open(source)
    await session.run('all')
    const views = byLine(session, source)
    expect(views[1]?.stdout).toBe('hola\n')
    expect(views[1]?.ms).toBeGreaterThanOrEqual(0)
  })

  it('las figuras viajan aparte, como imágenes, y la vista solo avisa de que existen', async ({
    skip,
  }) => {
    if (!withMatplotlib) return skip()
    const source = 'import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\n'
    const { session, changes } = open(source)
    await session.run('all')
    const view = byLine(session, source)[2]
    expect(view?.assets).toBe(true)
    const message = changes.find((c) => c.type === 'assets')
    expect(message?.type === 'assets' && message.assets.figures[0]?.mime).toBe('image/png')
    expect(view?.seq !== undefined && session.assetsOf(view.seq)?.figures).toHaveLength(1)
  })
})

describe('el resumen de un valor en una línea', () => {
  it('dice el tipo y la forma', () => {
    expect(
      describeSummary({ type: 'ndarray', module: 'numpy', shape: [200, 2], dtype: 'float64' }),
    ).toBe('ndarray 200×2 float64')
    expect(describeSummary({ type: 'ndarray', module: 'numpy', shape: [3], dtype: 'int64' })).toBe(
      'ndarray (3) int64',
    )
    expect(describeSummary({ type: 'list', module: 'builtins', length: 3 })).toBe('list 3')
    expect(describeSummary({ type: 'int', module: 'builtins', repr: '42' })).toBe('int 42')
    expect(
      describeSummary({
        type: 'Tensor',
        module: 'torch',
        shape: [8, 3],
        dtype: 'torch.float32',
        device: 'cuda:0',
      }),
    ).toBe('Tensor 8×3 torch.float32 cuda:0')
  })

  it('un DataFrame no repite el tipo de cada columna', () => {
    expect(
      describeSummary({
        type: 'DataFrame',
        module: 'pandas',
        shape: [1200, 8],
        table: { columns: [], rows: [] },
      }),
    ).toBe('DataFrame 1200×8')
  })
})
