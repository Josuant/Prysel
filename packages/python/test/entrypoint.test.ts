import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '../src/index.ts'

/**
 * `if __name__ == "__main__":` es el idioma con el que un script marca por dónde empieza a correr. Prysel
 * traza el archivo como `__main__`, así que la condición vale siempre: se trata como un territorio de un
 * solo camino (como un `with`), no como una decisión con una salida que en la práctica nunca se toma.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => Program
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source))
}, 30_000)

describe('el idioma de entrada de un script', () => {
  it('se reconoce como un territorio propio, no como una decisión', () => {
    const program = parse('def main():\n    pass\n\nif __name__ == "__main__":\n    main()\n')
    const entry = program.nodes.find((n) => n.line === 4)
    expect(entry?.kind).toBe('control.entrypoint')
    expect(entry?.contains).toBeDefined()
    const inside = program.nodes.find((n) => n.line === 5)
    expect(inside && entry?.contains).toContain(inside?.id)
  })

  it('da igual el orden de los dos lados de la comparación', () => {
    const program = parse('if "__main__" == __name__:\n    x = 1\n')
    expect(program.nodes[0]?.kind).toBe('control.entrypoint')
  })

  it('con un else (o un elif) ya no es el idioma puro: sigue siendo una decisión de verdad', () => {
    const withElse = parse('if __name__ == "__main__":\n    x = 1\nelse:\n    x = 2\n')
    expect(withElse.nodes[0]?.kind).toBe('control.condition')
    const withElif = parse('if __name__ == "__main__":\n    x = 1\nelif True:\n    x = 2\n')
    expect(withElif.nodes[0]?.kind).toBe('control.condition')
  })

  it('una condición parecida pero distinta sigue siendo una decisión normal', () => {
    const otherName = parse('if __name__ == "__mane__":\n    x = 1\n')
    expect(otherName.nodes[0]?.kind).toBe('control.condition')
    const otherVar = parse('if module == "__main__":\n    x = 1\n')
    expect(otherVar.nodes[0]?.kind).toBe('control.condition')
    const notEqual = parse('if __name__ != "__main__":\n    x = 1\n')
    expect(notEqual.nodes[0]?.kind).toBe('control.condition')
  })

  it('lo de dentro se ejecuta en secuencia, sin las etiquetas "verdadero"/"falso" de una rama', () => {
    const program = parse('if __name__ == "__main__":\n    a = 1\n    b = 2\n')
    const labels = program.edges.map((e) => e.label).filter((label) => label !== undefined)
    expect(labels).not.toContain('verdadero')
    expect(labels).not.toContain('falso')
    const entry = program.nodes.find((n) => n.kind === 'control.entrypoint')
    const a = program.nodes.find((n) => n.line === 2)
    const b = program.nodes.find((n) => n.line === 3)
    expect(program.edges).toContainEqual(
      expect.objectContaining({ from: entry?.id, to: a?.id, relation: 'transform' }),
    )
    expect(program.edges).toContainEqual(
      expect.objectContaining({ from: a?.id, to: b?.id, relation: 'sequence' }),
    )
  })

  it('lo que hay antes y después en el módulo sigue conectado con normalidad', () => {
    const program = parse('a = 1\nif __name__ == "__main__":\n    b = 2\nc = 3\n')
    const kinds = program.nodes.map((n) => n.kind)
    expect(kinds).toEqual(['value.number', 'control.entrypoint', 'value.number', 'value.number'])
  })
})
