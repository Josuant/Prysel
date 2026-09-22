import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser } from '@prysel/python'
import { anthropicProvider, DEFAULT_ANTHROPIC_MODEL } from '../src/ai/anthropic.ts'
import { generateLesson, MAX_ATTEMPTS } from '../src/ai/generate.ts'
import {
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  statementList,
  traceSummary,
  TRACE_EVENT_LIMIT,
} from '../src/ai/prompt.ts'
import type { AiProvider } from '../src/ai/provider.ts'
import { validateGenerated } from '../src/ai/validate.ts'
import { Kernel } from '../src/kernel.ts'
import { NOTE_STYLE_IDS } from '../src/lesson.ts'
import type { Trace } from '../src/trace.ts'

/**
 * La generación de una lección con IA: los textos que se le piden al modelo, que no se acepta nada que no
 * pase la validación (y se le pide corregirlo), y los dos proveedores.
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

const SOURCE = readFileSync(path.join(examples, 'factorial.py'), 'utf8')

describe('los textos que se le piden al modelo', () => {
  it('la lista de sentencias trae la línea y el texto de cada una', () => {
    const list = statementList(parse(SOURCE))
    expect(list).toContain('L1: def factorial(n):')
    expect(list).toContain('L7: total = 0')
    expect(list).toContain('L8: for i in range(1, 4):')
    // En orden de línea.
    const lines = list.split('\n').map((row) => Number(row.match(/^L(\d+)/)?.[1]))
    expect([...lines].sort((a, b) => a - b)).toEqual(lines)
  })

  it('un programa sin pasos lo dice, en vez de una lista vacía', () => {
    expect(traceSummary({ events: [], truncated: false, error: null, output: '' })).toBe(
      '(sin pasos)',
    )
  })

  it('la traza se resume con la línea, lo que cambió, lo que llama, devuelve o imprime', () => {
    const trace: Trace = {
      events: [
        { k: 'line', l: 1, d: 0, f: 0, ch: { x: 1 } },
        { k: 'call', l: 2, d: 1, f: 1, fn: 'f', ch: { n: 3 } },
        { k: 'return', l: 3, d: 1, f: 1, v: 6 },
        { k: 'line', l: 4, d: 0, f: 0, o: 'hola\n' },
        { k: 'exception', l: 5, d: 0, f: 0, e: 'ValueError: mal' },
        { k: 'end', l: 5, d: 0, f: 0 },
      ],
      truncated: false,
      error: null,
      output: 'hola\n',
    }
    const summary = traceSummary(trace)
    expect(summary).toContain('L1: x=1')
    expect(summary).toContain('L2: entra en f(n=3)')
    expect(summary).toContain('L3: devuelve 6')
    expect(summary).toContain('(imprime "hola\\n")')
    expect(summary).toContain('L5: lanza ValueError: mal')
    expect(summary).toContain('L5: el programa termina')
  })

  it('una traza larga se corta y lo dice', () => {
    const many: Trace = {
      events: Array.from({ length: 10 }, (_, i) => ({ k: 'line' as const, l: i + 1, d: 0, f: 0 })),
      truncated: false,
      error: null,
      output: '',
    }
    const summary = traceSummary(many, 4)
    expect(summary.split('\n')).toHaveLength(5)
    expect(summary).toContain('se cortó aquí: 6 pasos más')
    expect(traceSummary(many, TRACE_EVENT_LIMIT)).not.toContain('se cortó')
  })

  it('el mensaje de sistema exige JSON puro, ancla exacta, y enumera las clases de nota', () => {
    const system = buildSystemPrompt()
    expect(system).toContain('Responde solo el JSON')
    for (const style of NOTE_STYLE_IDS) expect(system).toContain(style)
  })

  it('el pedido concreto lleva el archivo, el idioma, las sentencias y la traza', () => {
    const trace: Trace = { events: [], truncated: false, error: null, output: '' }
    const prompt = buildUserPrompt(parse(SOURCE), trace, { source: 'factorial.py', lang: 'en' })
    expect(prompt).toContain('Archivo: factorial.py')
    expect(prompt).toContain('Idioma de las notas: en')
    expect(prompt).toContain('def factorial(n):')
    expect(prompt).not.toContain('Nivel:')
  })

  it('la reparación repite el pedido, la respuesta que falló y el motivo exacto', () => {
    const repaired = buildRepairPrompt('PEDIDO', 'RESPUESTA', 'MOTIVO')
    expect(repaired).toContain('PEDIDO')
    expect(repaired).toContain('RESPUESTA')
    expect(repaired).toContain('MOTIVO')
  })
})

describe.skipIf(!available)('validar lo que genera el modelo, contra una traza real', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  const good = (extra: Record<string, unknown> = {}) => ({
    version: 1,
    title: 'El factorial',
    beats: [{ at: { text: 'total = 0' }, note: { text: 'Empieza en cero.' } }],
    ...extra,
  })

  it('acepta un guion cuyas anclas existen y se ejecutan', async () => {
    const trace = await kernel.trace(SOURCE)
    const result = validateGenerated(parse(SOURCE), trace, good())
    expect(result.ok).toBe(true)
  })

  it('rechaza un ancla que no es ninguna sentencia del programa', async () => {
    const trace = await kernel.trace(SOURCE)
    const bad = good({ beats: [{ at: { text: 'esto no existe' }, note: { text: 'x' } }] })
    const result = validateGenerated(parse(SOURCE), trace, bad)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/no es ninguna sentencia/)
  })

  it('rechaza un «visit» que pide más vueltas de las que da la traza', async () => {
    const trace = await kernel.trace(SOURCE)
    const bad = good({
      beats: [
        {
          at: { text: 'if n <= 1:' },
          when: { text: 'if n <= 1:', visit: 99 },
          note: { text: 'x' },
        },
      ],
    })
    const result = validateGenerated(parse(SOURCE), trace, bad)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/no se ejecuta 99 veces/)
  })

  it('rechaza una pregunta sobre un nombre que no existe ahí', async () => {
    const trace = await kernel.trace(SOURCE)
    const bad = good({
      beats: [
        {
          at: { text: 'total = 0' },
          note: { text: 'x' },
          ask: { text: '¿?', expect: 'value', name: 'no_existe' },
        },
      ],
    })
    const result = validateGenerated(parse(SOURCE), trace, bad)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/pregunta pide el valor/)
  })

  it('rechaza lo que no es ni un guion (formato roto)', async () => {
    const trace = await kernel.trace(SOURCE)
    const result = validateGenerated(parse(SOURCE), trace, { version: 2 })
    expect(result.ok).toBe(false)
  })
})

/** Un proveedor de mentira: devuelve las respuestas que se le dan, en orden, y cuenta cuántas veces se llamó. */
function fakeProvider(responses: readonly string[]): AiProvider & { calls: number } {
  let i = 0
  return {
    id: 'fake:test',
    calls: 0,
    async generate() {
      this.calls++
      const response = responses[i++]
      if (response === undefined) throw new Error('sin más respuestas preparadas')
      return response
    },
  }
}

describe.skipIf(!available)('generar con reparación, sobre una traza real', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  const options = { source: 'factorial.py', lang: 'es' }
  const validJson = JSON.stringify({
    version: 1,
    title: 'El factorial',
    beats: [{ at: { text: 'total = 0' }, note: { text: 'Empieza en cero.' } }],
  })

  it('si acierta a la primera, un solo intento', async () => {
    const trace = await kernel.trace(SOURCE)
    const provider = fakeProvider([validJson])
    const result = await generateLesson(parse(SOURCE), trace, provider, options)
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(provider.calls).toBe(1)
  })

  it('un JSON envuelto en una valla de código también se acepta', async () => {
    const trace = await kernel.trace(SOURCE)
    const provider = fakeProvider(['```json\n' + validJson + '\n```'])
    const result = await generateLesson(parse(SOURCE), trace, provider, options)
    expect(result.ok).toBe(true)
  })

  it('un JSON roto, y luego uno con un ancla inventada, y a la tercera uno bueno: se acepta con 3 intentos', async () => {
    const trace = await kernel.trace(SOURCE)
    const broken = '{ "version": 1, '
    const wrongAnchor = JSON.stringify({
      version: 1,
      title: 'x',
      beats: [{ at: { text: 'esto no existe' }, note: { text: 'x' } }],
    })
    const provider = fakeProvider([broken, wrongAnchor, validJson])
    const result = await generateLesson(parse(SOURCE), trace, provider, options)
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(3)
  })

  it('si nunca acierta, falla tras el tope de intentos con el último motivo', async () => {
    const trace = await kernel.trace(SOURCE)
    const alwaysBad = JSON.stringify({ version: 1, title: 'x', beats: [] })
    const provider = fakeProvider([alwaysBad, alwaysBad, alwaysBad, alwaysBad])
    const result = await generateLesson(parse(SOURCE), trace, provider, options)
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(MAX_ATTEMPTS)
    expect(provider.calls).toBe(MAX_ATTEMPTS)
    expect(result.error).toMatch(/ningún momento/)
  })

  it('si el proveedor falla (sin red, sin permiso), no sigue insistiendo', async () => {
    const trace = await kernel.trace(SOURCE)
    const provider: AiProvider = {
      id: 'fake:roto',
      generate: () => Promise.reject(new Error('sin conexión')),
    }
    const result = await generateLesson(parse(SOURCE), trace, provider, options)
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(1)
    expect(result.error).toContain('sin conexión')
  })
})

describe('el proveedor de Anthropic', () => {
  const request = { system: 's', prompt: 'p' }

  it('devuelve el texto de la respuesta', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'hola' }] }), {
        status: 200,
      })) as unknown as typeof fetch
    const provider = anthropicProvider({ apiKey: 'x', fetchImpl })
    expect(await provider.generate(request)).toBe('hola')
    expect(provider.id).toBe(`anthropic:${DEFAULT_ANTHROPIC_MODEL}`)
  })

  it('junta varios bloques de texto, e ignora los que no lo son', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'a' }, { type: 'other' }, { type: 'text', text: 'b' }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const provider = anthropicProvider({ apiKey: 'x', fetchImpl })
    expect(await provider.generate(request)).toBe('ab')
  })

  it('un modelo propio cambia el id y va en el cuerpo de la petición', async () => {
    let sentModel: string | undefined
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      sentModel = (JSON.parse(init.body) as { model: string }).model
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    const provider = anthropicProvider({ apiKey: 'x', model: 'claude-otro', fetchImpl })
    await provider.generate(request)
    expect(provider.id).toBe('anthropic:claude-otro')
    expect(sentModel).toBe('claude-otro')
  })

  it('la clave va en la cabecera, nunca en la URL', async () => {
    let headers: Record<string, string> | undefined
    const fetchImpl = (async (_url: unknown, init: { headers: Record<string, string> }) => {
      headers = init.headers
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await anthropicProvider({ apiKey: 'secreta', fetchImpl }).generate(request)
    expect(headers?.['x-api-key']).toBe('secreta')
  })

  it('una respuesta de error cuenta el motivo, sin reventar', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'clave inválida' } }), {
        status: 401,
      })) as unknown as typeof fetch
    const provider = anthropicProvider({ apiKey: 'mala', fetchImpl })
    await expect(provider.generate(request)).rejects.toThrow(/401.*clave inválida/)
  })

  it('una respuesta sin texto también es un fallo, no una lección vacía', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ content: [] }), { status: 200 })) as unknown as typeof fetch
    await expect(anthropicProvider({ apiKey: 'x', fetchImpl }).generate(request)).rejects.toThrow()
  })
})
