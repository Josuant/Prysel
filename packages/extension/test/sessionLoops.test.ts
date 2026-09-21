import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser } from '@prysel/python'
import { Kernel } from '../src/kernel.ts'
import { Session } from '../src/session.ts'

/**
 * Los valores por vuelta llegan a la sesión atados a la sentencia que define el bucle (por su texto):
 * siguen a la sentencia si cambia de línea, se olvidan si se edita o se vuelve a ejecutar, y un bucle
 * de una función se ve en la definición, no en la llamada.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0

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

describe.skipIf(!available)('los valores por vuelta en la sesión', () => {
  const sessions: Session[] = []
  const open = (source: string) => {
    const session = new Session(
      () => Kernel.start({ python }),
      () => undefined,
    )
    sessions.push(session)
    session.update(parse(source), source)
    return session
  }
  /** Los bucles de cada sentencia, por la línea de esta. */
  const loopsByLine = (session: Session, source: string) => {
    const views = session.views()
    return Object.fromEntries(
      parse(source).nodes.flatMap((node) => {
        const view = views[node.id]
        return view ? [[node.line, view.loops]] : []
      }),
    )
  }
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose()
  })

  const SOURCE = 'total = 0\nfor i in range(4):\n    total += i\nprint(total)\n'

  it('el bucle de una sentencia llega con sus vueltas, por línea:columna dentro de ella', async () => {
    const session = open(SOURCE)
    await session.run('all')
    const loops = loopsByLine(session, SOURCE)
    expect(loops[1]).toBeUndefined()
    expect(loops[2]?.['1:0']).toMatchObject({
      n: 4,
      done: true,
      idx: [0, 1, 2, 3],
      names: { i: [0, 1, 2, 3], total: [0, 1, 3, 6] },
    })
    expect(loops[4]).toBeUndefined()
  })

  it('un bucle de una función se ve en su definición, aunque corra al llamarla', async () => {
    const source =
      'def f(n):\n    s = 0\n    for k in range(n):\n        s += k\n    return s\n\nf(3)\n'
    const session = open(source)
    await session.run('all')
    const loops = loopsByLine(session, source)
    expect(loops[1]?.['3:4']?.names['s']).toEqual([0, 1, 3])
    expect(loops[7]).toBeUndefined()
  })

  it('insertar una línea encima conserva las vueltas', async () => {
    const session = open(SOURCE)
    await session.run('all')
    const moved = `import os\n${SOURCE}`
    session.update(parse(moved), moved)
    expect(loopsByLine(session, moved)[3]?.['1:0']?.n).toBe(4)
  })

  it('editar el bucle las olvida', async () => {
    const session = open(SOURCE)
    await session.run('all')
    const edited = SOURCE.replace('range(4)', 'range(5)')
    session.update(parse(edited), edited)
    expect(loopsByLine(session, edited)[2]).toBeUndefined()
  })

  it('volver a ejecutar reemplaza las vueltas de la vez anterior', async () => {
    const source = 'import random\nfor i in range(random.randint(2, 3)):\n    pass\n'
    const session = open(source)
    await session.run('all')
    const first = loopsByLine(session, source)[2]?.['1:0']?.n
    await session.run('all')
    const second = loopsByLine(session, source)[2]?.['1:0']?.n
    expect([2, 3]).toContain(first)
    expect([2, 3]).toContain(second)
  })

  it('reiniciar las olvida', async () => {
    const session = open(SOURCE)
    await session.run('all')
    session.restart()
    expect(Object.values(loopsByLine(session, SOURCE)).every((l) => l === undefined)).toBe(true)
  })

  it('un bucle que sigue corriendo se ve a medias, y al acabar queda hecho', async () => {
    const source = 'import time\nfor i in range(4):\n    time.sleep(0.4)\n'
    const session = open(source)
    const running = session.run('all')
    await new Promise((resolve) => setTimeout(resolve, 900))
    const midway = loopsByLine(session, source)[2]?.['1:0']
    expect(midway?.done).toBe(false)
    expect(midway?.idx.length).toBeGreaterThan(0)
    await running
    expect(loopsByLine(session, source)[2]?.['1:0']).toMatchObject({ n: 4, done: true })
  }, 20_000)
})
