import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '../src/index.ts'
import { actionEdits, applyEdits } from '../src/edits.ts'

/**
 * Las etapas se editan desde el lienzo como todo lo demás: renombrar una reescribe su rótulo, dividir un
 * bloque escribe los rótulos que hacen falta y quitar una borra solo su comentario.
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
const idAt = (program: Program, line: number) =>
  program.nodes.find((n) => n.line === line)?.id ?? `nada en la línea ${line}`

const TWO = lines(
  'def f():',
  '    """Doc."""',
  '    # ── 1. Preparar: los datos ──',
  '    a = 1',
  '',
  '    # Calcular',
  '    c = a + 1',
)

describe('renombrar una etapa', () => {
  it('reescribe solo su texto: se quedan los adornos y la numeración', () => {
    const program = parse(TWO)
    const id = program.sections?.[0]?.id ?? ''
    const { edits } = actionEdits(program, {
      type: 'retitle',
      id,
      title: 'Cargar:  lo que haga falta',
    })
    const after = applyEdits(TWO, edits)
    expect(after).toContain('    # ── 1. Cargar: lo que haga falta ──\n')
    expect(parse(after).sections?.[0]).toMatchObject({
      title: 'Cargar',
      subtitle: 'lo que haga falta',
    })
  })

  it('un título vacío, con saltos de línea o igual que el de antes no rompe nada', () => {
    const program = parse(TWO)
    const id = program.sections?.[1]?.id ?? ''
    expect(actionEdits(program, { type: 'retitle', id, title: '   ' }).edits).toEqual([])
    expect(actionEdits(program, { type: 'retitle', id, title: 'Calcular' }).edits).toEqual([])
    const { edits } = actionEdits(program, { type: 'retitle', id, title: 'Uno\ndos' })
    expect(applyEdits(TWO, edits)).toContain('    # Uno dos\n')
  })
})

describe('quitar una etapa', () => {
  it('borra su rótulo entero y deja sus sentencias', () => {
    const source = lines('# %% Uno', '# (con dos líneas)', 'x = 1', '', '# %% Dos', 'y = 2')
    const program = parse(source)
    const { edits } = actionEdits(program, {
      type: 'unsection',
      id: program.sections?.[0]?.id ?? '',
    })
    const after = applyEdits(source, edits)
    expect(after).toBe(lines('x = 1', '', '# %% Dos', 'y = 2'))
    expect(parse(after).sections?.map((s) => s.title)).toEqual(['Dos'])
  })
})

describe('dividir un bloque en etapas', () => {
  it('sin etapas, escribe un rótulo al principio del bloque y otro donde se divide', () => {
    const source = lines('def f():', '    a = 1', '    b = 2', '    c = a + b')
    const program = parse(source)
    const { edits } = actionEdits(program, {
      type: 'section',
      id: idAt(program, 4),
      title: 'Sumar',
      first: 'Preparar',
    })
    const after = applyEdits(source, edits)
    expect(after).toBe(
      lines(
        'def f():',
        '    # Preparar',
        '    a = 1',
        '    b = 2',
        '',
        '    # Sumar',
        '    c = a + b',
      ),
    )
    const sections = parse(after).sections
    expect(sections?.map((s) => s.title)).toEqual(['Preparar', 'Sumar'])
  })

  it('si la primera sentencia ya lleva un comentario encima, ese pasa a ser su rótulo', () => {
    const source = lines('for i in x:', '    # Leer', '    a = i', '    b = a * 2')
    const program = parse(source)
    const { edits } = actionEdits(program, {
      type: 'section',
      id: idAt(program, 4),
      title: 'Doblar',
    })
    const after = applyEdits(source, edits)
    expect(after).toBe(
      lines('for i in x:', '    # Leer', '    a = i', '', '    # Doblar', '    b = a * 2'),
    )
    expect(parse(after).sections?.map((s) => s.title)).toEqual(['Leer', 'Doblar'])
  })

  it('con etapas, añade solo la nueva; sobre la primera sentencia o una que ya abre una, no hace nada', () => {
    const program = parse(TWO)
    const extra = lines(
      'def f():',
      '    """Doc."""',
      '    # ── 1. Preparar: los datos ──',
      '    a = 1',
      '',
      '    # Calcular',
      '    c = a + 1',
      '    d = c * 2',
    )
    const withD = parse(extra)
    const { edits } = actionEdits(withD, { type: 'section', id: idAt(withD, 8), title: 'Doblar' })
    expect(parse(applyEdits(extra, edits)).sections?.map((s) => s.title)).toEqual([
      'Preparar',
      'Calcular',
      'Doblar',
    ])
    expect(
      actionEdits(program, { type: 'section', id: idAt(program, 7), title: 'X' }).edits,
    ).toEqual([])
    const plain = parse(lines('a = 1', 'b = 2'))
    expect(actionEdits(plain, { type: 'section', id: idAt(plain, 1), title: 'X' }).edits).toEqual(
      [],
    )
  })

  it('respeta los saltos de línea de Windows', () => {
    const source = 'a = 1\r\nb = 2\r\n'
    const program = parse(source)
    const { edits } = actionEdits(program, { type: 'section', id: idAt(program, 2), title: 'Dos' })
    expect(applyEdits(source, edits)).toBe('# Primera etapa\r\na = 1\r\n\r\n# Dos\r\nb = 2\r\n')
  })
})
