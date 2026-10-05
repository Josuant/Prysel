import { createRequire } from 'node:module'
import path from 'node:path'
import type { TemplateId } from '@prysel/morphology'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  actionEdits,
  applyEdits,
  clearGenerating,
  fillGenerated,
  untouchedTemplate,
} from '../src/edits.ts'
import { buildProgram, createPythonParser, type Program } from '../src/index.ts'

/**
 * Una pieza que se puso con una orden nace con la marca `# prysel:gen:<id>`: su contenido aún se está
 * escribiendo. La marca vive en el código (es estado, no una nota) y se va cuando llega el contenido.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parser: Awaited<ReturnType<typeof createPythonParser>>
let parse: (source: string) => Program

beforeAll(async () => {
  parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
}, 30_000)

const valid = (text: string) => !parser.parse(text).rootNode.hasError

/** Añade una plantilla marcada al final de `source` (o dentro de `into`, por su etiqueta). */
function add(source: string, template: TemplateId, into?: string) {
  const program = parse(source)
  const owner = into ? program.nodes.find((n) => n.label === into)?.id : undefined
  const change = actionEdits(program, {
    type: 'add',
    template,
    pending: 'k3f9',
    ...(owner ? { into: owner } : {}),
  })
  const text = applyEdits(source, change.edits)
  return { text, program: parse(text), change }
}

describe('una pieza que se está generando', () => {
  it('nace con su marca en la primera línea, y el analizador la reconoce', () => {
    const { text, program, change } = add('total = 0\n', 'for')
    expect(text).toBe('total = 0\nfor elemento in range(10):  # prysel:gen:k3f9\n    pass\n')
    const node = program.nodes.find((n) => n.generating === 'k3f9')
    expect(node?.kind).toBe('control.loop')
    expect(node?.line).toBe(change.select?.line)
    // La marca no es una nota, ni abre una etapa.
    expect(node?.note).toBeUndefined()
    expect(program.sections ?? []).toEqual([])
  })

  it('vale para cada plantilla: una sentencia, un bloque o una función', () => {
    for (const template of [
      'variable',
      'print',
      'if',
      'ifelse',
      'while',
      'try',
      'function',
    ] as const) {
      const { text, program } = add('x = 1\n', template)
      expect(valid(text), template).toBe(true)
      expect(
        program.nodes.filter((n) => n.generating === 'k3f9'),
        template,
      ).toHaveLength(1)
    }
  })

  it('una nota de verdad en la misma línea se conserva; la marca no entra en ella', () => {
    const program = parse('x = 1  # prysel:gen:ab12\ny = 2  # el doble\n')
    expect(program.nodes.find((n) => n.label === 'x')?.generating).toBe('ab12')
    expect(program.nodes.find((n) => n.label === 'x')?.note).toBeUndefined()
    expect(program.nodes.find((n) => n.label === 'y')?.note).toBe('el doble')
    expect(program.nodes.find((n) => n.label === 'y')?.generating).toBeUndefined()
  })

  it('un id que no es un id no se escribe', () => {
    const program = parse('x = 1\n')
    const change = actionEdits(program, { type: 'add', template: 'print', pending: 'no vale #' })
    expect(applyEdits('x = 1\n', change.edits)).toBe('x = 1\nprint("Hola")\n')
  })

  it('el contenido sustituye a la plantilla entera, con la sangría de su sitio', () => {
    const source = 'def entrenar():\n    total = 0\n    return total\n'
    const { text, program } = add(source, 'for', 'entrenar')
    expect(text).toContain('    for elemento in range(10):  # prysel:gen:k3f9\n        pass\n')
    expect(untouchedTemplate(program, 'k3f9', 'for')).toBe(true)
    const filled = applyEdits(
      text,
      fillGenerated(program, 'k3f9', 'for n in range(1, 6):\n    total += n\n').edits,
    )
    expect(filled).toBe(
      'def entrenar():\n    total = 0\n    for n in range(1, 6):\n        total += n\n    return total\n',
    )
    expect(parse(filled).nodes.some((n) => n.generating !== undefined)).toBe(false)
  })

  it('una sentencia sola también, y con los saltos de línea de Windows', () => {
    const { text, program } = add('x = 1\r\n', 'variable')
    expect(text).toBe('x = 1\r\nvariable = 0  # prysel:gen:k3f9\r\n')
    const filled = applyEdits(text, fillGenerated(program, 'k3f9', 'contador = 0').edits)
    expect(filled).toBe('x = 1\r\ncontador = 0\r\n')
    const block = add('x = 1\r\n', 'while')
    const done = applyEdits(
      block.text,
      fillGenerated(block.program, 'k3f9', 'while x < 5:\n    x += 1').edits,
    )
    expect(done).toBe('x = 1\r\nwhile x < 5:\r\n    x += 1\r\n')
  })

  it('si alguien ya tocó la plantilla, se sabe: lo generado no debe pisarla', () => {
    const { text } = add('x = 1\n', 'for')
    const touched = parse(text.replace('pass', 'print(elemento)'))
    expect(untouchedTemplate(touched, 'k3f9', 'for')).toBe(false)
    expect(untouchedTemplate(touched, 'otro', 'for')).toBe(false)
  })

  it('quitar la marca deja la pieza como está', () => {
    const { text, program } = add('x = 1\n', 'if')
    const cleared = applyEdits(text, clearGenerating(program, 'k3f9').edits)
    expect(cleared).toBe('x = 1\nif valor > 0:\n    pass\n')
    expect(clearGenerating(parse(cleared), 'k3f9').edits).toEqual([])
  })
})
