import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '../src/index.ts'

/**
 * Los subprocesos: a qué funciones, clases y métodos del archivo llama cada sentencia, aunque la llamada
 * vaya dentro de una comprensión, anidada o por un objeto. Es lo que deja abrir `volar` desde la línea
 * que hace volar a toda la población.
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
/** Los nombres a los que llama la sentencia de una línea. */
const calleesAt = (program: Program, line: number) => {
  const label = new Map(program.nodes.map((n) => [n.id, n.label]))
  return (program.nodes.find((n) => n.line === line)?.callees ?? []).map((id) => label.get(id))
}

describe('a qué llama cada sentencia', () => {
  it('dentro de una comprensión, anidadas (en el orden en que se ejecutan) y sin contar lo que no es del archivo', () => {
    const program = parse(
      lines(
        'def volar(g):',
        '    return g',
        'def cruzar(a, b):',
        '    return a',
        'def mutar(g):',
        '    return g',
        'resultados = [volar(g) for g in range(3)]',
        'hija = mutar(cruzar(1, 2))',
        'print(len(resultados))',
      ),
    )
    expect(calleesAt(program, 7)).toEqual(['volar'])
    expect(calleesAt(program, 8)).toEqual(['cruzar', 'mutar'])
    expect(calleesAt(program, 9)).toEqual([])
  })

  it('una función definida más abajo también se reconoce', () => {
    const program = parse(lines('def main():', '    ayuda()', '', 'def ayuda():', '    pass'))
    expect(calleesAt(program, 2)).toEqual(['ayuda'])
  })

  it('los métodos, por la instancia creada en el mismo ámbito, por `self` y por la clase', () => {
    const program = parse(
      lines(
        'class Pajaro:',
        '    def mover(self):',
        '        self.frenar()',
        '    def frenar(self):',
        '        pass',
        'def volar():',
        '    p = Pajaro()',
        '    p.mover()',
        '    Pajaro.frenar(p)',
      ),
    )
    const label = new Map(program.nodes.map((n) => [n.id, n]))
    expect(calleesAt(program, 3)).toEqual(['frenar'])
    expect(calleesAt(program, 7)).toEqual(['Pajaro'])
    expect(calleesAt(program, 8)).toEqual(['mover'])
    expect(calleesAt(program, 9)).toEqual(['frenar'])
    // Y lo que devuelve son ids de verdad: el método, dentro de su clase.
    const mover = program.nodes.find((n) => n.line === 8)?.callees?.[0]
    expect(mover && label.get(mover)?.range?.owner).toBe(
      program.nodes.find((n) => n.line === 1)?.id,
    )
  })

  it('una compuesta llama a lo de su cabecera, no a lo de su cuerpo', () => {
    const program = parse(
      lines('def ok():', '    return True', 'def f():', '    pass', 'while ok():', '    f()'),
    )
    expect(calleesAt(program, 5)).toEqual(['ok'])
    expect(calleesAt(program, 6)).toEqual(['f'])
  })

  it('un objeto que llega de fuera no se adivina', () => {
    const program = parse(
      lines('class C:', '    def m(self):', '        pass', 'def usar(obj):', '    obj.m()'),
    )
    expect(calleesAt(program, 5)).toEqual([])
  })
})
