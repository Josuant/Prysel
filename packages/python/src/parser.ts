import type { Language, Parser as ParserType, Tree } from '@vscode/tree-sitter-wasm'

/**
 * Carga de tree-sitter. Se usa la build que embarca VS Code: es la misma que correrá
 * dentro de la extensión, así que lo que funcione aquí funcionará allí.
 *
 * tree-sitter es tolerante a errores: devuelve un árbol utilizable aunque el código esté
 * a medio escribir. Eso es lo que permite dibujar el diagrama mientras alguien teclea,
 * en vez de esperar a que el archivo compile.
 */

export interface WasmLocations {
  /** Carpeta o URL donde vive `tree-sitter.wasm` (el runtime). */
  runtime: string
  /** Ruta o URL del `tree-sitter-python.wasm` (la gramática). */
  language: string
}

export interface PythonParser {
  parse(source: string, previous?: Tree): Tree
  /** Libera el árbol y el parser. */
  dispose(): void
}

interface TreeSitterModule {
  Parser: {
    new (): ParserType
    init(options?: { locateFile?: (file: string) => string }): Promise<void>
  }
  Language: { load(path: string): Promise<Language> }
}

let ready: Promise<TreeSitterModule> | null = null

async function loadModule(locations: WasmLocations): Promise<TreeSitterModule> {
  ready ??= (async () => {
    const module = (await import('@vscode/tree-sitter-wasm')) as unknown as TreeSitterModule
    await module.Parser.init({
      locateFile: (file: string) =>
        locations.runtime.endsWith('.wasm') ? locations.runtime : `${locations.runtime}/${file}`,
    })
    return module
  })()
  return ready
}

export async function createPythonParser(locations: WasmLocations): Promise<PythonParser> {
  const module = await loadModule(locations)
  const language = await module.Language.load(locations.language)
  const parser = new module.Parser()
  parser.setLanguage(language)

  return {
    parse(source, previous) {
      // Con el árbol anterior, tree-sitter solo reanaliza lo que cambió.
      const tree = parser.parse(source, previous)
      if (!tree) throw new Error('tree-sitter no devolvió un árbol')
      return tree
    },
    dispose() {
      parser.delete()
    },
  }
}
