import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser } from '@prysel/python'
import { Kernel } from '../src/kernel.ts'
import { Session } from '../src/session.ts'
import { indexOf, stateAt, type Trace } from '../src/trace.ts'
import {
  cursorNode,
  describeEvent,
  enclosingFunction,
  formatShown,
  nodeAtLine,
  observedAt,
  variablesAt,
} from '../webview/src/player.ts'

/**
 * La reproducción sobre el diagrama: de la traza real de un programa a qué nodo se ilumina, qué valen sus
 * chips y cómo se cuenta cada paso.
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

const SOURCE = [
  'def doble(n):',
  '    return n * 2',
  '',
  'total = 0',
  'for i in range(3):',
  '    total = total + doble(i)',
  'print(total)',
  '',
].join('\n')

describe('las líneas y los nodos', () => {
  it('cada sentencia sabe dónde acaba: una compuesta, con su cuerpo', () => {
    const program = parse(SOURCE)
    const at = (line: number) => program.nodes.find((node) => node.line === line)
    expect(at(1)?.lineEnd).toBe(2)
    expect(at(5)?.lineEnd).toBe(6)
    expect(at(4)?.lineEnd).toBe(4)
  })

  it('una línea es del nodo más interno que la abarca', () => {
    const program = parse(SOURCE)
    expect(nodeAtLine(program, 5)?.kind).toBe('control.loop')
    expect(nodeAtLine(program, 6)?.line).toBe(6)
    expect(nodeAtLine(program, 2)?.kind).toBe('control.return')
    expect(nodeAtLine(program, 3)).toBeUndefined()
  })

  it('un nodo de una función sabe en cuál está', () => {
    const program = parse(SOURCE)
    expect(enclosingFunction(program, nodeAtLine(program, 2) as never)).toBe('doble')
    expect(enclosingFunction(program, nodeAtLine(program, 6) as never)).toBeNull()
  })
})

describe('formatear lo que enseña la traza', () => {
  it('lo escribe como Python', () => {
    expect(formatShown(null)).toBe('None')
    expect(formatShown(true)).toBe('True')
    expect(formatShown(false)).toBe('False')
    expect(formatShown(2.5)).toBe('2.5')
    expect(formatShown("'a'")).toBe("'a'")
  })
})

describe.skipIf(!available)('con la traza real de un programa', () => {
  const sessions: Session[] = []
  afterAll(() => {
    for (const session of sessions) session.dispose()
  })

  const record = async (source: string): Promise<Trace> => {
    const session = new Session(
      () => Kernel.start({ python }),
      () => undefined,
    )
    sessions.push(session)
    session.update(parse(source), source)
    const trace = await session.trace(source)
    if (!trace) throw new Error('no se pudo grabar')
    return trace
  }

  it('la sesión graba la traza sin tocar lo ya ejecutado', async () => {
    const trace = await record(SOURCE)
    expect(trace.error).toBeNull()
    expect(trace.output).toBe('6\n')
    expect(trace.events.some((event) => event.k === 'call' && event.fn === 'doble')).toBe(true)
  }, 30_000)

  it('el cursor recorre los nodos del programa, y los chips valen lo que valían en cada paso', async () => {
    const program = parse(SOURCE)
    const index = indexOf(await record(SOURCE))
    const visible = new Set(program.nodes.map((node) => node.id))
    const total = program.nodes.find((node) => node.line === 4)
    expect(total?.provides).toBe('total')
    const id = total?.id ?? ''

    // Antes de que se ejecute la línea 4, `total` no existe; justo después, vale 0.
    const steps = index.trace.events.map((_, i) => stateAt(index, i))
    const before = steps.find((state) => state.event?.l === 4)
    const after = steps.find((state) => state.event?.l === 5)
    expect(before && observedAt(program, before).get(id)).toBeUndefined()
    expect(after && observedAt(program, after).get(id)?.['total']?.short).toBe('0')

    // El cursor está en el nodo de la línea del paso.
    expect(before && cursorNode(program, before, visible)).toBe(id)

    // Al final, el total acumulado (0 + 0 + 1 + 2 ... = 0 + 2 + 4 = 6) lo lleva el nodo del bucle.
    const last = stateAt(index, index.trace.events.length - 1)
    const inLoop = program.nodes.find((node) => node.line === 6)
    expect(observedAt(program, last).get(inLoop?.id ?? '')?.['total']?.short).toBe('6')
  }, 30_000)

  it('dentro de una función, el cursor sube a la función si esta está plegada', async () => {
    const program = parse(SOURCE)
    const index = indexOf(await record(SOURCE))
    const def = program.nodes.find((node) => node.line === 1)
    const inside = stateAt(
      index,
      index.trace.events.findIndex((event) => event.l === 2),
    )
    const folded = new Set(program.nodes.filter((n) => n.line !== 2).map((n) => n.id))
    expect(cursorNode(program, inside, folded)).toBe(def?.id)
  }, 30_000)

  it('si la función ni siquiera se ve, el cursor se queda en la llamada que la abrió', async () => {
    const program = parse(SOURCE)
    const index = indexOf(await record(SOURCE))
    const call = program.nodes.find((node) => node.line === 6)
    const inside = stateAt(
      index,
      index.trace.events.findIndex((event) => event.l === 2),
    )
    const hidden = new Set([1, 2].flatMap((line) => program.nodes.filter((n) => n.line === line)))
    const visible = new Set(program.nodes.filter((n) => !hidden.has(n)).map((n) => n.id))
    expect(cursorNode(program, inside, visible)).toBe(call?.id)
  }, 30_000)

  it('cada paso se cuenta con una frase y con las variables que se ven', async () => {
    const program = parse(SOURCE)
    const index = indexOf(await record(SOURCE))
    const call = stateAt(
      index,
      index.trace.events.findIndex((event) => event.k === 'call'),
    )
    expect(describeEvent(program, call)).toBe('Entra en doble(n=0)')
    expect(variablesAt(call).find((v) => v.name === 'n')?.changed).toBe(true)
    // Definir la función también es un paso: el programa empieza por ahí.
    expect(describeEvent(program, stateAt(index, 0))).toBe('def doble(n):')
    expect(describeEvent(program, stateAt(index, -1))).toBe('Antes de empezar')
  }, 30_000)
})

describe('formatear una lista grabada', () => {
  it('se lee como Python: corchetes, paréntesis, y los puntos suspensivos si faltan elementos', () => {
    expect(formatShown({ l: [1, 'a', null, true], n: 4, t: 'list' } as never)).toBe(
      '[1, a, None, True]',
    )
    expect(formatShown({ l: [1], n: 1, t: 'tuple' } as never)).toBe('(1,)')
    expect(formatShown({ l: [1, 2], n: 2, t: 'tuple' } as never)).toBe('(1, 2)')
    expect(formatShown({ l: [1, 2], n: 9, t: 'list' } as never)).toBe('[1, 2, …]')
    expect(formatShown({ l: [], n: 0, t: 'list' } as never)).toBe('[]')
  })
})
