import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits, sectionInserts } from '@prysel/python/edits'
import type { AiProvider, AiRequest } from '../src/ai/provider.ts'
import {
  MAX_ATTEMPTS,
  buildSectionsPrompt,
  buildSectionsSystemPrompt,
  proposeSections,
  sectionBlocks,
  validateSections,
} from '../src/ai/sections.ts'

/**
 * La IA propone las etapas de un código que no las tiene. Nada de lo que diga se escribe sin pasar la
 * validación (anclas de verdad, al menos dos por bloque) y, al final, lo que se escribe son comentarios de
 * sección normales que el analizador reconoce como etapas. Nunca se llama a una IA real: el proveedor es de
 * mentira y devuelve lo que diga la prueba.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => Program
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
}, 30_000)

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

/** Un algoritmo sin comentarios de sección: su cuerpo tiene fases, pero nadie las ha nombrado. */
const PLAIN = lines(
  'def entrenar(poblacion):',
  '    mejor = 0',
  '    for generacion in range(5):',
  '        notas = [len(g) for g in poblacion]',
  '        media = sum(notas) / len(notas)',
  '        orden = sorted(notas)',
  '        mejor = max(mejor, orden[-1])',
  '        poblacion = poblacion[:2] * 2',
  '        x = 0',
  '        x = 0',
  '    print(mejor)',
)

/** Un proveedor de mentira: devuelve, por orden, lo que se le dé, y apunta lo que se le pidió. */
function fake(responses: string[]): AiProvider & { requests: AiRequest[] } {
  const requests: AiRequest[] = []
  return {
    id: 'mentira',
    requests,
    generate(request: AiRequest) {
      requests.push(request)
      return Promise.resolve(responses.shift() ?? '{}')
    },
  }
}

const GOOD = JSON.stringify({
  sections: [
    {
      before: { text: 'notas = [len(g) for g in poblacion]' },
      title: 'Probar: cada genoma se mide',
    },
    { before: { text: 'orden = sorted(notas)' }, title: '# Juzgar:   el mejor   gana' },
    { before: { text: 'poblacion = poblacion[:2] * 2' }, title: 'Relevo: la élite se copia' },
  ],
})

describe('qué bloques merecen etapas', () => {
  it('los largos que aún no tienen: aquí, el cuerpo del bucle (el de la función tiene solo tres sentencias)', () => {
    const blocks = sectionBlocks(parse(PLAIN))
    expect(blocks.map((block) => block.title)).toEqual([
      'el cuerpo del bucle «for generacion in range(5):»',
    ])
    expect(blocks[0]?.statements).toHaveLength(7)
  })

  it('un bloque que ya tiene etapas no se toca', () => {
    const program = parse(
      lines(
        'for i in range(3):',
        '    # Uno',
        '    a = i',
        '    b = a',
        '',
        '    # Dos',
        '    c = b',
        '    d = c',
      ),
    )
    expect(sectionBlocks(program)).toEqual([])
  })
})

describe('los textos que se le piden al modelo', () => {
  it('explican qué es una etapa y el formato exacto', () => {
    const system = buildSectionsSystemPrompt()
    expect(system).toContain('"sections"')
    expect(system).toContain('entre 2 y 7 etapas')
  })

  it('el pedido lista cada bloque con sus sentencias, y dice cuál es cuál si se repiten', () => {
    const program = parse(PLAIN)
    const prompt = buildSectionsPrompt(program, sectionBlocks(program))
    expect(prompt).toContain('Bloque 1: el cuerpo del bucle')
    expect(prompt).toContain('L4: notas = [len(g) for g in poblacion]')
    expect(prompt).toContain('L10: x = 0   (repetida: "nth": 2)')
  })
})

describe('lo que propone se valida antes de nada', () => {
  it('una propuesta buena: anclas de verdad, títulos limpios, en el orden del archivo', () => {
    const program = parse(PLAIN)
    const checked = validateSections(program, sectionBlocks(program), JSON.parse(GOOD))
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.sections.map((s) => s.title)).toEqual([
      'Probar: cada genoma se mide',
      'Juzgar: el mejor gana',
      'Relevo: la élite se copia',
    ])
  })

  it.each([
    [{}, 'Falta la lista "sections"'],
    [{ sections: [{ before: { text: 'no_existe = 1' }, title: 'X' }] }, 'no es ninguna sentencia'],
    [{ sections: [{ before: { text: 'mejor = 0' }, title: 'X' }] }, 'no es una sentencia directa'],
    [
      { sections: [{ before: { text: 'orden = sorted(notas)' }, title: 'Solo una' }] },
      'una sola etapa',
    ],
    [
      {
        sections: [
          { before: { text: 'orden = sorted(notas)' }, title: 'A' },
          { before: { text: 'orden = sorted(notas)' }, title: 'B' },
        ],
      },
      'ya empieza otra etapa',
    ],
    [
      {
        sections: [
          { before: { text: 'orden = sorted(notas)' }, title: 'A'.repeat(90) },
          { before: { text: 'media = sum(notas) / len(notas)' }, title: 'B' },
        ],
      },
      'pasa de 80',
    ],
  ])('rechaza %j', (raw, why) => {
    const program = parse(PLAIN)
    const checked = validateSections(program, sectionBlocks(program), raw)
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.error).toContain(why)
  })
})

describe('proposeSections', () => {
  it('si la primera respuesta no vale, le dice el motivo exacto y se queda con la corregida', async () => {
    const program = parse(PLAIN)
    const provider = fake([
      JSON.stringify({ sections: [{ before: { text: 'orden = sorted(notas)' }, title: 'Solo' }] }),
      GOOD,
    ])
    const result = await proposeSections(program, provider)
    expect(result).toMatchObject({ ok: true, attempts: 2 })
    expect(provider.requests[1]?.prompt).toContain('una sola etapa')
  })

  it('no gasta una llamada si no hay nada que partir, y no insiste más de la cuenta', async () => {
    const none = fake([])
    const done = await proposeSections(parse(lines('a = 1', 'b = 2')), none)
    expect(done).toMatchObject({ ok: false, attempts: 0 })
    expect(none.requests).toHaveLength(0)

    const stubborn = fake(['no es json', 'tampoco', 'nada'])
    const result = await proposeSections(parse(PLAIN), stubborn)
    expect(result).toMatchObject({ ok: false, attempts: MAX_ATTEMPTS })
    expect(stubborn.requests).toHaveLength(MAX_ATTEMPTS)
  })

  it('lo propuesto se escribe como comentarios de sección que el analizador reconoce como etapas', async () => {
    const program = parse(PLAIN)
    const result = await proposeSections(program, fake([GOOD]))
    if (!result.ok) throw new Error(result.error)
    const after = applyEdits(PLAIN, sectionInserts(program, result.sections))
    expect(after).toContain('\n\n        # Juzgar: el mejor gana\n        orden = sorted(notas)\n')
    const sections = parse(after).sections ?? []
    expect(sections.map((s) => [s.title, s.subtitle])).toEqual([
      ['Probar', 'cada genoma se mide'],
      ['Juzgar', 'el mejor gana'],
      ['Relevo', 'la élite se copia'],
    ])
    // El código de antes no cambia: solo se añaden comentarios (y las líneas en blanco que los separan).
    const code = (text: string) =>
      text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
    expect(code(after)).toEqual(code(PLAIN))
  })
})
