import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser } from '@prysel/python'
import { Kernel } from '../src/kernel.ts'
import {
  LESSON_LIMITS,
  lessonFileFor,
  parseLesson,
  readLesson,
  skeletonLesson,
  type Lesson,
} from '../src/lesson.ts'
import { Session } from '../src/session.ts'
import { parseWebviewMessage } from '../src/protocol.ts'
import {
  anchorNode,
  currentMoment,
  lessonNotes,
  momentsOf,
  resolveBeats,
} from '../webview/src/lessons.ts'

/**
 * El guion de una lección: su formato (que lo escribe cualquiera, así que se valida), cómo se ata a un
 * programa por el texto de sus sentencias y qué notas se ven en cada paso.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
const examples = path.resolve(__dirname, '../../../examples/lecciones')

let parse: (source: string) => ReturnType<typeof buildProgram>
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source) => buildProgram(parser.parse(source), source)
}, 30_000)

const minimal = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  title: 'Prueba',
  beats: [{ at: { text: 'x = 1' }, note: { text: 'Aquí se define x.' } }],
  ...extra,
})

describe('el formato del guion', () => {
  it('acepta lo mínimo y rellena lo que falta', () => {
    const result = parseLesson(minimal())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lesson.beats[0]).toEqual({
      id: 'b1',
      at: { text: 'x = 1' },
      note: { text: 'Aquí se define x.', style: 'sticky' },
    })
  })

  it('conserva el momento, el nth y la clase de nota', () => {
    const result = parseLesson(
      minimal({
        beats: [
          {
            id: 'a',
            at: { text: 'x = 1', nth: 2 },
            when: { text: 'y = 2', visit: 3 },
            note: { text: 'Hola', style: 'warning', title: 'Ojo' },
          },
        ],
      }),
    )
    expect(result.ok && result.lesson.beats[0]).toEqual({
      id: 'a',
      at: { text: 'x = 1', nth: 2 },
      when: { text: 'y = 2', visit: 3 },
      note: { text: 'Hola', style: 'warning', title: 'Ojo' },
    })
  })

  it('ignora lo que no conoce en vez de arrastrarlo', () => {
    const result = parseLesson(minimal({ secreto: 'x', trace: { events: [] } }))
    expect(result.ok && Object.keys(result.lesson)).toEqual(['version', 'title', 'beats'])
  })

  it.each([
    ['no es un objeto', []],
    ['versión desconocida', minimal({ version: 2 })],
    ['sin título', minimal({ title: '' })],
    ['beats no es lista', minimal({ beats: {} })],
    ['un momento sin nota', minimal({ beats: [{ at: { text: 'x' } }] })],
    ['una nota sin texto', minimal({ beats: [{ at: { text: 'x' }, note: { text: '  ' } }] })],
    ['un ancla vacía', minimal({ beats: [{ at: { text: '' }, note: { text: 'a' } }] })],
    ['nth cero', minimal({ beats: [{ at: { text: 'x', nth: 0 }, note: { text: 'a' } }] })],
    [
      'visit no entero',
      minimal({
        beats: [{ at: { text: 'x' }, when: { text: 'x', visit: 1.5 }, note: { text: 'a' } }],
      }),
    ],
    [
      'una clase de nota que no existe',
      minimal({ beats: [{ at: { text: 'x' }, note: { text: 'a', style: 'brillante' } }] }),
    ],
    [
      'ids repetidos',
      minimal({
        beats: [
          { id: 'a', at: { text: 'x' }, note: { text: 'a' } },
          { id: 'a', at: { text: 'y' }, note: { text: 'b' } },
        ],
      }),
    ],
  ])('rechaza con su motivo: %s', (_name, value) => {
    const result = parseLesson(value)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(5)
  })

  it('pone tope a lo que un guion puede pedir', () => {
    const many = Array.from({ length: LESSON_LIMITS.beats + 1 }, (_, i) => ({
      at: { text: `x${i}` },
      note: { text: 'a' },
    }))
    expect(parseLesson(minimal({ beats: many })).ok).toBe(false)
    const long = 'a'.repeat(LESSON_LIMITS.text + 1)
    expect(parseLesson(minimal({ beats: [{ at: { text: 'x' }, note: { text: long } }] })).ok).toBe(
      false,
    )
    expect(readLesson('x'.repeat(LESSON_LIMITS.file + 1)).ok).toBe(false)
  })

  it('un JSON roto dice que lo es, no revienta', () => {
    const result = readLesson('{ "version": 1, ')
    expect(!result.ok && result.error).toMatch(/JSON/)
  })

  it('el guion vive junto al programa', () => {
    expect(lessonFileFor('/a/b/factorial.py')).toBe('/a/b/factorial.lesson.json')
    expect(lessonFileFor('C:\\x\\Prog.PY')).toBe('C:\\x\\Prog.lesson.json')
  })

  it('el guion de partida es válido y trae las primeras sentencias', () => {
    const text = skeletonLesson('demo.py', ['a = 1', 'b = 2', 'c = 3', 'd = 4', 'e = 5'])
    const result = readLesson(text)
    expect(result.ok && result.lesson.beats.map((b) => b.at.text)).toEqual([
      'a = 1',
      'b = 2',
      'c = 3',
      'd = 4',
    ])
  })
})

describe('en el mensaje al lienzo', () => {
  it('el guion se vuelve a validar al llegar', () => {
    const lesson = parseLesson(minimal())
    if (!lesson.ok) throw new Error('debería ser válido')
    const good = { type: 'lesson', file: 'a.py', lesson: lesson.lesson }
    expect(parseWebviewMessage(good)).toEqual(good)
    expect(parseWebviewMessage({ ...good, lesson: { ...lesson.lesson, version: 9 } })).toBeNull()
    expect(parseWebviewMessage({ ...good, file: 3 })).toBeNull()
  })

  it('sin guion, o con el motivo por el que no se pudo leer', () => {
    expect(parseWebviewMessage({ type: 'lesson', file: 'a.py', lesson: null })).toEqual({
      type: 'lesson',
      file: 'a.py',
      lesson: null,
    })
    const broken = { type: 'lesson', file: 'a.py', lesson: null, error: 'JSON roto' }
    expect(parseWebviewMessage(broken)).toEqual(broken)
    expect(parseWebviewMessage({ ...broken, error: 4 })).toBeNull()
  })
})

const SOURCE = readFileSync(path.join(examples, 'factorial.py'), 'utf8')
const example = (): Lesson => {
  const result = readLesson(readFileSync(path.join(examples, 'factorial.lesson.json'), 'utf8'))
  if (!result.ok) throw new Error(result.error)
  return result.lesson
}

describe('el ancla por el texto de la sentencia', () => {
  it('encuentra el nodo aunque cambien los espacios o la línea', () => {
    const moved = parse('\n\n' + SOURCE.replace('total = 0', 'total   =   0'))
    expect(anchorNode(moved, { text: 'total = 0' })?.text).toBe('total   =   0')
    expect(anchorNode(moved, { text: 'total = 0' })?.line).toBe(9)
  })

  it('elige la que se pide cuando hay varias, y ninguna si no existe', () => {
    const program = parse('x = 1\ny = 2\nx = 1\n')
    expect(anchorNode(program, { text: 'x = 1', nth: 2 })?.line).toBe(3)
    expect(anchorNode(program, { text: 'x = 1', nth: 3 })).toBeNull()
    expect(anchorNode(program, { text: 'z = 9' })).toBeNull()
  })

  it('una cabecera se reconoce sin los dos puntos', () => {
    const program = parse(SOURCE)
    expect(anchorNode(program, { text: 'for i in range(1, 4)' })?.line).toBe(8)
  })
})

describe('las notas que se ven', () => {
  it('la lección de ejemplo es válida y todas sus anclas están en el programa', () => {
    const program = parse(SOURCE)
    const lesson = example()
    expect(lesson.beats.length).toBeGreaterThan(3)
    for (const beat of lesson.beats) {
      expect(anchorNode(program, beat.at), beat.id).not.toBeNull()
    }
  })

  it('la nota de una función que se ve como chip cuelga de ese chip', () => {
    const program = parse(SOURCE)
    const resolved = resolveBeats(program, example(), null)
    const definition = program.nodes.find((n) => n.line === 1)
    const visible = new Set(program.nodes.filter((n) => n.line > 4).map((n) => n.id))
    const { links } = lessonNotes(program, resolved, null, visible, new Set([definition?.id ?? '']))
    expect(links.find((link) => link.to === 'note:idea')?.from).toBe(`fn:${definition?.id}`)
  })

  it('sin reproducir, todas las notas cuelgan de su nodo (o de la llamada si la función no se ve)', () => {
    const program = parse(SOURCE)
    const lesson = example()
    const resolved = resolveBeats(program, lesson, null)
    expect(resolved.every((r) => r.step === null)).toBe(true)
    // Se ve todo menos lo de dentro de la función.
    const inside = new Set(program.nodes.filter((n) => n.line >= 1 && n.line <= 4).map((n) => n.id))
    const visible = new Set(program.nodes.filter((n) => !inside.has(n.id)).map((n) => n.id))
    const { nodes, links } = lessonNotes(program, resolved, null, visible)
    expect(nodes).toHaveLength(lesson.beats.length)
    expect(links.every((link) => visible.has(link.from))).toBe(true)
    expect(nodes.every((n) => n.handwritten && !n.handwritten.current && !n.handwritten.past)).toBe(
      true,
    )
  })
})

describe.skipIf(!available)('con la traza real', () => {
  const sessions: Session[] = []
  afterAll(() => {
    for (const session of sessions) session.dispose()
  })
  const record = async () => {
    const session = new Session(
      () => Kernel.start({ python }),
      () => undefined,
    )
    sessions.push(session)
    session.update(parse(SOURCE), SOURCE)
    const trace = await session.trace(SOURCE)
    if (!trace) throw new Error('sin traza')
    return trace
  }

  it('cada momento cae en el paso de su sentencia, y `visit` elige la vez', async () => {
    const program = parse(SOURCE)
    const trace = await record()
    const resolved = resolveBeats(program, example(), trace)
    const stepOf = (id: string) => resolved.find((r) => r.beat.id === id)?.step ?? -1
    expect(resolved.every((r) => r.step !== null)).toBe(true)
    // La línea de cada evento en el paso elegido.
    const lineAt = (id: string) => trace.events[stepOf(id)]?.l
    expect(lineAt('idea')).toBe(1)
    expect(lineAt('cero')).toBe(7)
    expect(lineAt('caso-base')).toBe(2)
    // La 3.ª vez que se llega a `if n <= 1:` es más tarde que la 1.ª.
    const first = trace.events.findIndex((e) => e.l === 2 && e.k === 'line')
    expect(stepOf('caso-base')).toBeGreaterThan(first)
    // Los momentos salen en el orden en que ocurren.
    const moments = momentsOf(resolved)
    expect(moments.map((m) => m.step)).toEqual(
      [...moments.map((m) => m.step)].sort((a, b) => a - b),
    )
    expect(moments[0]?.beat.id).toBe('idea')
    expect(moments.at(-1)?.beat.id).toBe('fin')
  }, 30_000)

  it('reproduciendo, solo se ven las notas que ya llegaron, y la última manda', async () => {
    const program = parse(SOURCE)
    const trace = await record()
    const resolved = resolveBeats(program, example(), trace)
    const visible = new Set(program.nodes.map((n) => n.id))
    const moments = momentsOf(resolved)
    const cero = resolved.find((r) => r.beat.id === 'cero')?.step ?? -1

    // Las que aún no llegaron conservan su sitio (para que nada se mueva al aparecer) pero no se dibujan.
    const shown = (step: number) =>
      lessonNotes(program, resolved, step, visible).nodes.filter((n) => !n.handwritten?.hidden)
    expect(lessonNotes(program, resolved, -1, visible).nodes).toHaveLength(example().beats.length)
    expect(shown(-1)).toHaveLength(0)
    const at = shown(cero)
    expect(at.map((n) => n.id)).toEqual(['note:idea', 'note:cero'])
    expect(at[0]?.handwritten?.past).toBe(true)
    expect(at[1]?.handwritten?.current).toBe(true)
    expect(currentMoment(moments, cero)?.beat.id).toBe('cero')
    expect(currentMoment(moments, -1)).toBeNull()
    const end = lessonNotes(program, resolved, trace.events.length - 1, visible)
    expect(end.nodes).toHaveLength(example().beats.length)
    expect(end.links.map((l) => l.relation)).toEqual(end.links.map(() => 'transform'))
  }, 30_000)

  it('una nota cuyo programa no llega hasta ahí no tiene paso, pero sigue teniendo nodo', async () => {
    const program = parse('x = 1\nif x > 5:\n    y = 2\n')
    const session = new Session(
      () => Kernel.start({ python }),
      () => undefined,
    )
    sessions.push(session)
    session.update(program, 'x = 1\nif x > 5:\n    y = 2\n')
    const trace = await session.trace('x = 1\nif x > 5:\n    y = 2\n')
    const lesson = parseLesson(
      minimal({ beats: [{ at: { text: 'y = 2' }, note: { text: 'Nunca' } }] }),
    )
    if (!lesson.ok || !trace) throw new Error('preparación')
    const [only] = resolveBeats(program, lesson.lesson, trace)
    expect(only?.node).not.toBeNull()
    expect(only?.step).toBeNull()
  }, 30_000)
})

describe('las lecciones de ejemplo', () => {
  const load = (name: string) => {
    const source = readFileSync(path.join(examples, `${name}.py`), 'utf8')
    const result = readLesson(readFileSync(path.join(examples, `${name}.lesson.json`), 'utf8'))
    if (!result.ok) throw new Error(`${name}: ${result.error}`)
    return { source, lesson: result.lesson }
  }

  it.each(['factorial', 'burbuja', 'alias'])(
    '%s: es válida y todas sus anclas están en el programa',
    (name) => {
      const { source, lesson } = load(name)
      const program = parse(source)
      for (const beat of lesson.beats) {
        expect(anchorNode(program, beat.at), `${name}/${beat.id}`).not.toBeNull()
        if (beat.when) expect(anchorNode(program, beat.when), `${name}/${beat.id}`).not.toBeNull()
      }
    },
  )

  it('cada una pide los nodos para entender que le hacen falta', () => {
    expect(load('factorial').lesson.show).toEqual(['stack', 'tree'])
    expect(load('burbuja').lesson.show).toEqual(['collection', 'variables'])
    expect(load('alias').lesson.show).toEqual(['memory', 'variables'])
  })
})
