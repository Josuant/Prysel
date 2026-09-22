import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser } from '@prysel/python'
import { cacheKeyOf } from '../src/ai/cache.ts'
import type { AiProvider } from '../src/ai/provider.ts'
import {
  buildCodeRepairPrompt,
  buildCodeSystemPrompt,
  buildCodeUserPrompt,
  CODE_MAX_ATTEMPTS,
  CODE_MAX_LINES,
  generateTopic,
  SAFE_MODULES,
  TOPIC_TRACE_LIMIT,
  type TopicRuntime,
} from '../src/ai/topic.ts'
import { Kernel } from '../src/kernel.ts'

/**
 * «Explicar un tema»: los textos que se le piden al modelo para el código, la caché por
 * (tema, nivel, idioma, proveedor), y el flujo completo (código → modo seguro → traza real → guion),
 * incluida su reparación cuando el código no vale.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

describe('los textos que se le piden al modelo para el código', () => {
  it('exige JSON puro, el tope de líneas y solo los módulos de la lista', () => {
    const system = buildCodeSystemPrompt()
    expect(system).toContain('Responde solo el JSON')
    expect(system).toContain(String(CODE_MAX_LINES))
    for (const mod of SAFE_MODULES) expect(system).toContain(mod)
  })

  it('el pedido lleva el tema y, si lo hay, el nivel', () => {
    const conNivel = buildCodeUserPrompt({ topic: 'recursión', level: 'para quien empieza' })
    expect(conNivel).toContain('Tema: recursión')
    expect(conNivel).toContain('Nivel: para quien empieza')

    const sinNivel = buildCodeUserPrompt({ topic: 'recursión' })
    expect(sinNivel).not.toContain('Nivel:')
  })

  it('la reparación repite el pedido, la respuesta que falló y el motivo exacto', () => {
    const repaired = buildCodeRepairPrompt('PEDIDO', 'RESPUESTA', 'MOTIVO')
    expect(repaired).toContain('PEDIDO')
    expect(repaired).toContain('RESPUESTA')
    expect(repaired).toContain('MOTIVO')
  })
})

describe('la caché por (tema, nivel, idioma, proveedor)', () => {
  it('la misma clave para lo mismo, distinta si cambia cualquier campo', () => {
    const base = {
      topic: 'recursión',
      level: 'inicial',
      lang: 'es',
      providerId: 'vscode:gpt-4o-mini',
    }
    expect(cacheKeyOf(base)).toBe(cacheKeyOf({ ...base }))
    expect(cacheKeyOf(base)).not.toBe(cacheKeyOf({ ...base, topic: 'iteración' }))
    expect(cacheKeyOf(base)).not.toBe(cacheKeyOf({ ...base, level: 'avanzado' }))
    expect(cacheKeyOf(base)).not.toBe(cacheKeyOf({ ...base, lang: 'en' }))
    expect(cacheKeyOf(base)).not.toBe(cacheKeyOf({ ...base, providerId: 'anthropic:claude-x' }))
  })

  it('espacios y mayúsculas de más no cambian la clave', () => {
    const a = cacheKeyOf({ topic: 'Recursión', providerId: 'x' })
    const b = cacheKeyOf({ topic: '  recursión  ', providerId: 'x' })
    expect(a).toBe(b)
  })
})

/** Un proveedor de mentira: devuelve las respuestas dadas, en orden, y guarda cada pedido que recibió. */
function fakeProvider(
  responses: readonly string[],
): AiProvider & { calls: number; prompts: string[] } {
  let i = 0
  return {
    id: 'fake:test',
    calls: 0,
    prompts: [],
    async generate(request) {
      this.calls++
      this.prompts.push(request.prompt)
      const response = responses[i++]
      if (response === undefined) throw new Error('sin más respuestas preparadas')
      return response
    },
  }
}

const GOOD_CODE = [
  'def es_par(numero):',
  '    return numero % 2 == 0',
  '',
  'for i in range(3):',
  '    print(es_par(i))',
  '',
].join('\n')
const goodCodeJson = (title = 'Números pares') => JSON.stringify({ title, code: GOOD_CODE })
const goodLessonJson = JSON.stringify({
  version: 1,
  title: 'Números pares',
  beats: [{ at: { text: 'for i in range(3):' }, note: { text: 'Repite tres veces.' } }],
})

describe.skipIf(!available)('generar un tema: código en modo seguro → traza real → guion', () => {
  let kernel: Kernel
  let parse: (source: string) => ReturnType<typeof buildProgram>
  let runtime: TopicRuntime

  beforeAll(async () => {
    kernel = await Kernel.start({ python })
    const parser = await createPythonParser({
      runtime: wasmDir,
      language: path.join(wasmDir, 'tree-sitter-python.wasm'),
    })
    parse = (source) => buildProgram(parser.parse(source), source)
    runtime = {
      parse,
      trace: (code) => kernel.trace(code, TOPIC_TRACE_LIMIT, true),
    }
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  const options = { topic: 'paridad', lang: 'es', source: 'paridad.py' }

  it('si el código y el guion valen a la primera, un solo intento', async () => {
    const provider = fakeProvider([goodCodeJson(), goodLessonJson])
    const result = await generateTopic(provider, runtime, options)
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.title).toBe('Números pares')
    expect(result.lesson?.beats).toHaveLength(1)
  })

  it('un módulo prohibido se rechaza en modo seguro, sin ejecutar nada, y se repara', async () => {
    const unsafe = JSON.stringify({ title: 'x', code: "import os\nos.system('echo hola')\n" })
    const provider = fakeProvider([unsafe, goodCodeJson(), goodLessonJson])
    const result = await generateTopic(provider, runtime, options)
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    // El motivo que se le da de vuelta al modelo es el mismo que dice el motor (UnsafeCode).
    expect(provider.prompts[1]).toMatch(/no está permitido en modo seguro/)
  })

  it('un intento de escapar del sandbox por atributos también se rechaza', async () => {
    const unsafe = JSON.stringify({
      title: 'x',
      code: 'clases = ().__class__.__bases__[0].__subclasses__()\nprint(clases)\n',
    })
    const provider = fakeProvider([unsafe, goodCodeJson(), goodLessonJson])
    const result = await generateTopic(provider, runtime, options)
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(provider.prompts[1]).toMatch(/__subclasses__/)
  })

  it('un código con «input()» se rechaza antes de ejecutarlo (sin gastar una traza)', async () => {
    const withInput = JSON.stringify({ title: 'x', code: 'n = input()\nprint(n)\n' })
    const provider = fakeProvider([withInput, goodCodeJson(), goodLessonJson])
    const result = await generateTopic(provider, runtime, options)
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(provider.prompts[1]).toMatch(/input/)
  })

  it('un código con más líneas de las que caben en un diagrama se rechaza', async () => {
    const long = Array.from({ length: CODE_MAX_LINES + 5 }, (_, i) => `x${i} = ${i}`).join('\n')
    const tooLong = JSON.stringify({ title: 'x', code: long })
    const provider = fakeProvider([tooLong, goodCodeJson(), goodLessonJson])
    const result = await generateTopic(provider, runtime, options)
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(provider.prompts[1]).toMatch(new RegExp(String(CODE_MAX_LINES)))
  })

  it('un código que revienta al ejecutarse se repara con el error real', async () => {
    const broken = JSON.stringify({ title: 'x', code: 'print(1 / 0)\n' })
    const provider = fakeProvider([broken, goodCodeJson(), goodLessonJson])
    const result = await generateTopic(provider, runtime, options)
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(provider.prompts[1]).toMatch(/ZeroDivisionError/)
  })

  it('código que vale pero un guion que nunca lo hace: falla sin reintentar el código', async () => {
    const alwaysBadLesson = JSON.stringify({ version: 1, title: 'x', beats: [] })
    const provider = fakeProvider([
      goodCodeJson(),
      alwaysBadLesson,
      alwaysBadLesson,
      alwaysBadLesson,
    ])
    const result = await generateTopic(provider, runtime, options)
    expect(result.ok).toBe(false)
    // Solo UN intento de código (el guion agota sus propios 3, todos con el mismo código).
    expect(result.attempts).toBe(1)
    expect(result.code).toBe(GOOD_CODE)
    expect(result.error).toMatch(/guion no pasó la validación/)
  })

  it('si nunca llega a un código que valga, falla tras el tope de intentos', async () => {
    const alwaysUnsafe = JSON.stringify({ title: 'x', code: 'import socket\n' })
    const provider = fakeProvider([alwaysUnsafe, alwaysUnsafe, alwaysUnsafe])
    const result = await generateTopic(provider, runtime, options)
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(CODE_MAX_ATTEMPTS)
    expect(result.error).toMatch(/no está permitido en modo seguro/)
  })
})
