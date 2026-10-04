import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '../src/index.ts'
import { headingLine, splitTitle } from '../src/sections.ts'

/**
 * Las etapas: un comentario de sección abre un tramo de sentencias con nombre. Es lo que deja plegar un
 * algoritmo largo en sus fases («probar», «juzgar», «criar») sin cambiar ni una sentencia.
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
const idAt = (program: Program, line: number) => program.nodes.find((n) => n.line === line)?.id

describe('qué comentario abre una etapa', () => {
  it('dos comentarios tras una línea en blanco (o al principio del bloque) parten el bloque en dos etapas', () => {
    const program = parse(
      lines(
        'def f():',
        '    # Preparar: los datos',
        '    a = 1',
        '    b = 2',
        '',
        '    # Calcular',
        '    c = a + b',
      ),
    )
    const sections = program.sections ?? []
    expect(sections.map((s) => s.title)).toEqual(['Preparar', 'Calcular'])
    expect(sections[0]?.subtitle).toBe('los datos')
    expect(sections[0]?.members).toEqual([idAt(program, 3), idAt(program, 4)])
    expect(sections[1]?.members).toEqual([idAt(program, 7)])
    expect(sections.every((s) => s.owner === idAt(program, 1))).toBe(true)
    expect(sections[0]).toMatchObject({ line: 2, lineEnd: 4 })
    expect(sections[1]).toMatchObject({ line: 6, lineEnd: 7 })
  })

  it('un comentario suelto sigue siendo la nota de su sentencia, como siempre', () => {
    const program = parse(lines('def f():', '    a = 1', '', '    # Suma los dos', '    c = a + 2'))
    expect(program.sections).toEqual([])
    expect(program.nodes.find((n) => n.line === 5)?.note).toBe('Suma los dos')
  })

  it('un comentario pegado a la sentencia anterior (sin línea en blanco) no abre nada', () => {
    const program = parse(
      lines(
        'def f():',
        '    # Uno',
        '    a = 1',
        '    # dos',
        '    b = 2',
        '',
        '    # Tres',
        '    c = 3',
      ),
    )
    expect((program.sections ?? []).map((s) => s.title)).toEqual(['Uno', 'Tres'])
    // «dos» explica a `b`, dentro de la primera etapa.
    expect(program.nodes.find((n) => n.line === 5)?.note).toBe('dos')
    expect(program.sections?.[0]?.members).toEqual([idAt(program, 3), idAt(program, 5)])
  })

  it('una celda (`# %%`) o un rótulo con adornos basta sola', () => {
    const cell = parse(lines('x = 1', '# %% Cargar los datos', 'y = 2', 'z = 3'))
    expect(cell.sections?.map((s) => [s.title, s.explicit])).toEqual([['Cargar los datos', true]])
    expect(cell.sections?.[0]?.members).toEqual([idAt(cell, 3), idAt(cell, 4)])
    // Lo que va antes del primer rótulo no es de ninguna etapa.
    expect(cell.nodes.find((n) => n.line === 1)?.note).toBeUndefined()

    const banner = parse(lines('def f():', '    a = 1', '    # ── Resultado ──', '    print(a)'))
    expect(banner.sections?.map((s) => s.title)).toEqual(['Resultado'])
  })

  it('`# %% [markdown]` es una celda de texto, no de código', () => {
    const program = parse(lines('# %% [markdown]', '# Un título', 'x = 1'))
    expect(program.sections).toEqual([])
  })

  it('el principio del cuerpo de un bucle cuenta como principio de bloque (tree-sitter cuelga ese comentario del bucle)', () => {
    const program = parse(
      lines(
        'for g in range(3):',
        '    # Probar: vuelan',
        '    r = g * 2',
        '',
        '    # Relevo',
        '    x = r',
      ),
    )
    expect(program.sections?.map((s) => s.title)).toEqual(['Probar', 'Relevo'])
    expect(program.sections?.every((s) => s.owner === idAt(program, 1))).toBe(true)
    // El rótulo no es la nota del bucle ni de su primera sentencia.
    expect(program.nodes.find((n) => n.line === 1)?.note).toBeUndefined()
    expect(program.nodes.find((n) => n.line === 3)?.note).toBeUndefined()
  })

  it('tras un docstring, el primer comentario está al principio del bloque', () => {
    const program = parse(
      lines('def f():', '    """Doc."""', '    # Uno', '    a = 1', '', '    # Dos', '    b = 2'),
    )
    expect(program.sections?.map((s) => s.title)).toEqual(['Uno', 'Dos'])
  })

  it('en el módulo, y en las ramas de un if, también', () => {
    const module = parse(lines('# Datos', 'x = 1', '', '# Modelo', 'y = x * 2'))
    expect(module.sections?.map((s) => [s.title, s.owner])).toEqual([
      ['Datos', undefined],
      ['Modelo', undefined],
    ])

    const branch = parse(
      lines('if ok:', '    # Uno', '    a = 1', '', '    # Dos', '    b = 2', 'else:', '    c = 3'),
    )
    expect(branch.sections?.map((s) => [s.title, s.owner])).toEqual([
      ['Uno', idAt(branch, 1)],
      ['Dos', idAt(branch, 1)],
    ])
  })

  it('las etapas anidadas se devuelven en el orden del archivo', () => {
    const program = parse(
      lines(
        'def f():',
        '    # Antes',
        '    a = 1',
        '',
        '    # Bucle',
        '    for i in range(2):',
        '        # Dentro uno',
        '        b = i',
        '',
        '        # Dentro dos',
        '        c = b',
        '',
        '    # Después',
        '    print(a)',
      ),
    )
    expect(program.sections?.map((s) => s.title)).toEqual([
      'Antes',
      'Bucle',
      'Dentro uno',
      'Dentro dos',
      'Después',
    ])
    const loop = program.sections?.find((s) => s.title === 'Bucle')
    expect(loop?.members).toEqual([idAt(program, 6)])
    expect(loop?.lineEnd).toBe(11)
  })

  it('el else de un bucle va en la etapa de su bucle', () => {
    const program = parse(
      lines('# Uno', 'for i in x:', '    pass', 'else:', '    y = 1', '', '# Dos', 'z = 2'),
    )
    const first = program.sections?.[0]
    expect(first?.members).toHaveLength(2)
    expect(first?.members[1]?.startsWith('else')).toBe(true)
  })
})

describe('el rótulo y el texto', () => {
  it('el rótulo no forma parte del «lead» de la primera sentencia: borrarla no borra la etapa', () => {
    const source = lines('def f():', '    # Uno', '    a = 1', '', '    # Dos', '    b = 2')
    const program = parse(source)
    const first = program.nodes.find((n) => n.line === 3)
    expect(first?.range?.lead).toBeUndefined()
  })

  it('sabe dónde está el texto editable y el rótulo entero', () => {
    const source = lines(
      'def f():',
      '    # ── 1. Probar: vuelan ──',
      '    # (y se mide la aptitud)',
      '    a = 1',
      '',
      '    # Dos',
      '    b = 2',
    )
    const program = parse(source)
    const section = program.sections?.[0]
    expect(section).toMatchObject({ title: 'Probar', subtitle: 'vuelan', explicit: true })
    expect(section?.note).toBe('(y se mide la aptitud)')
    expect(source.slice(section?.textAt.start, section?.textAt.end)).toBe('Probar: vuelan')
    expect(source.slice(section?.heading.start, section?.heading.end)).toBe(
      '# ── 1. Probar: vuelan ──\n    # (y se mide la aptitud)',
    )
    expect(section?.id).toBe('section:2:4')
  })

  it('un rótulo sin sentencia detrás no se pierde', () => {
    const program = parse(lines('# %% Uno', 'a = 1', '# %% Dos', 'pass'))
    expect(program.sections?.map((s) => s.title)).toEqual(['Uno'])
    expect(program.nodes.find((n) => n.line === 2)?.note).toBe('Dos')
  })
})

describe('headingLine y splitTitle', () => {
  it('quitan la almohadilla, la celda, los adornos y la numeración', () => {
    expect(headingLine('# Probar')).toEqual({ explicit: false, text: 'Probar', offset: 2 })
    expect(headingLine('# %% Cargar')).toEqual({ explicit: true, text: 'Cargar', offset: 5 })
    expect(headingLine('# === Modelo ===')?.text).toBe('Modelo')
    expect(headingLine('# ── 2. Juzgar ──')).toMatchObject({ explicit: true, text: 'Juzgar' })
    expect(headingLine('# Paso 3: Criar')?.text).toBe('Criar')
    expect(headingLine('# 10 generaciones')?.text).toBe('10 generaciones')
    expect(headingLine('# ------')).toBeNull()
  })

  it('parten título y subtítulo por los dos puntos o por una pregunta', () => {
    expect(splitTitle('Probar: cada pájaro vuela')).toEqual({
      title: 'Probar',
      subtitle: 'cada pájaro vuela',
    })
    expect(splitTitle('¿Sigue vivo? Si no, acaba')).toEqual({
      title: '¿Sigue vivo?',
      subtitle: 'Si no, acaba',
    })
    expect(splitTitle('Relevo')).toEqual({ title: 'Relevo' })
  })
})
