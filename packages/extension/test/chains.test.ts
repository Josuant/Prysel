import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser } from '@prysel/python'
import { Kernel, type ChainSteps } from '../src/kernel.ts'
import { Session } from '../src/session.ts'

/**
 * Lo que valía una cadena de pasos tras cada uno: se anota al evaluarla (sin evaluar nada dos veces) y
 * llega a la sesión atado a la sentencia que la define.
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

describe.skipIf(!available)('lo que vale una cadena tras cada paso', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  /** Ejecuta y devuelve lo que anotó cada cadena, por su clave. */
  let counter = 0
  const chains = async (code: string, id = `c${++counter}`) => {
    const seen: ChainSteps[] = []
    const result = await kernel.run(code, { id, onSteps: (steps) => seen.push(steps) })
    const types = (key: string) =>
      seen.findLast((s) => s.chain === key)?.previews.map((p) => p?.type ?? null)
    return { result, seen, types }
  }

  it('el receptor y lo que queda tras cada paso, con su tipo', async () => {
    const { types, result } = await chains('r = "  Hola Mundo ".strip().lower().split()\n')
    expect(result.ok).toBe(true)
    expect(types('1:4')).toEqual(['str', 'str', 'str', 'list'])
    expect(result.values['r']?.items).toEqual(["'hola'", "'mundo'"])
  })

  it('un índice y un atributo también son pasos', async () => {
    const { types } = await chains('n = [3, 1, 2].copy()[0].real\n')
    expect(types('1:4')).toEqual(['list', 'list', 'int', 'int'])
  })

  it('cada paso se evalúa una sola vez: anotarlo no repite lo que hace', async () => {
    const { result } = await chains(
      'log = []\nclass C:\n    def a(self):\n        log.append("a")\n        return self\nC().a().a().a()\nlen(log)\n',
    )
    expect(result.result?.repr).toBe('3')
  })

  it('el valor que devuelve es el mismo con o sin anotar', async () => {
    const { result } = await chains('"a,b,c".split(",")[1].upper()\n')
    expect(result.result?.repr).toBe("'B'")
  })

  it('los atributos del principio son el receptor: `os.path.join(…).upper()`', async () => {
    const { types } = await chains('import os\np = os.path.join("a", "b").upper()\n')
    expect(types('2:4')).toEqual(['module', 'str', 'str'])
  })

  it('una cadena que falla a medias deja anotados los pasos que llegaron a evaluarse', async () => {
    const { result, types } = await chains('x = "a".upper().nope().lower()\n')
    expect(result.error?.name).toBe('AttributeError')
    expect(types('1:4')).toEqual(['str', 'str', null, null])
  })

  it('una cadena de una función anota cuando se la llama, con el fragmento que la definió', async () => {
    await chains('def limpiar(s):\n    return s.strip().lower()\n', 'def2')
    const seen: ChainSteps[] = []
    const run = await kernel.run('limpiar("  HOLA ")', {
      id: 'call2',
      onSteps: (s) => seen.push(s),
    })
    expect(run.result?.repr).toBe("'hola'")
    expect(seen.at(-1)).toMatchObject({ frag: 'def2', chain: '2:11' })
    expect(seen.at(-1)?.previews.map((p) => p?.type)).toEqual(['str', 'str', 'str'])
  })

  it('una cadena dentro de un bucle no se anota en cada vuelta', async () => {
    const { seen } = await chains('for i in range(500):\n    x = str(i).zfill(4).strip()\n')
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.length).toBeLessThanOrEqual(12)
  })

  it('un solo paso no es una cadena', async () => {
    const { seen } = await chains('a = "x".upper()\nb = [1, 2].copy()\n')
    expect(seen).toHaveLength(0)
  })

  it('las cadenas en varias líneas entre paréntesis se anotan donde empieza la expresión', async () => {
    const { types } = await chains('r = ("  a b "\n     .strip()\n     .split())\n')
    expect(types('1:5')).toEqual(['str', 'str', 'list'])
  })

  it('un número pequeño de un paso se ve como su valor', async () => {
    const { seen } = await chains('n = "abc".upper().count("B")\n')
    expect(seen.at(-1)?.previews.at(-1)).toMatchObject({ type: 'int', repr: '1' })
  })

  it('la tabla de un paso llega con sus filas como listas, no aplanadas a texto', async () => {
    const { seen } = await chains(
      [
        'class T:',
        '    columns = ["a", "b"]',
        '    dtypes = {"a": "int64", "b": "int64"}',
        '    shape = (2, 2)',
        '    values = property(lambda self: self)',
        '    def head(self, n=5): return self',
        '    def tolist(self): return [[1, 2], [3, 4]]',
        '    def __getitem__(self, cols): return self',
        '    def again(self): return self',
        't = T().again().again()',
      ].join('\n'),
    )
    const rows = seen.at(-1)?.previews.at(-1)?.table?.rows
    expect(rows).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('la clave usa la columna en bytes de UTF-8, como el intérprete', async () => {
    const { types } = await chains('é = "x".upper().lower()\n')
    expect(types('1:5')).toEqual(['str', 'str', 'str'])
  })
})

describe.skipIf(!available)('las cadenas en la sesión', () => {
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
  const chainsByLine = (session: Session, source: string) => {
    const views = session.views()
    return Object.fromEntries(
      parse(source).nodes.flatMap((node) => {
        const view = views[node.id]
        return view ? [[node.line, view.chains]] : []
      }),
    )
  }
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose()
  })

  const SOURCE = 'x = 1\nr = " a ".strip().upper()\n'

  it('cada cadena llega con lo que valía tras cada paso, atada a su sentencia', async () => {
    const session = open(SOURCE)
    await session.run('all')
    const chains = chainsByLine(session, SOURCE)
    expect(chains[1]).toBeUndefined()
    expect(chains[2]?.['1:4']?.map((p) => p?.type)).toEqual(['str', 'str', 'str'])
  })

  it('el anclaje del analizador coincide con la clave del motor', async () => {
    const session = open(SOURCE)
    await session.run('all')
    const node = parse(SOURCE).nodes.find((n) => n.line === 2)
    const statement = parse(SOURCE).nodes.find((n) => n.line === 2)
    const key = `${(node?.anchor?.line ?? 0) - (statement?.line ?? 0) + 1}:${node?.anchor?.col}`
    expect(chainsByLine(session, SOURCE)[2]?.[key]).toBeDefined()
  })

  it('una cadena de una función se ve en su definición', async () => {
    const source = 'def f(s):\n    return s.strip().upper()\n\nf(" a ")\n'
    const session = open(source)
    await session.run('all')
    const chains = chainsByLine(session, source)
    expect(Object.keys(chains[1] ?? {})).toEqual(['2:11'])
    expect(chains[4]).toBeUndefined()
  })

  it('editar la sentencia la olvida; insertar una línea encima la conserva', async () => {
    const session = open(SOURCE)
    await session.run('all')
    const moved = `import os\n${SOURCE}`
    session.update(parse(moved), moved)
    expect(chainsByLine(session, moved)[3]?.['1:4']).toBeDefined()
    const edited = SOURCE.replace('.upper()', '.lower()')
    session.update(parse(edited), edited)
    expect(chainsByLine(session, edited)[2]).toBeUndefined()
  })

  it('reiniciar las olvida', async () => {
    const session = open(SOURCE)
    await session.run('all')
    session.restart()
    expect(chainsByLine(session, SOURCE)[2]).toBeUndefined()
  })
})
