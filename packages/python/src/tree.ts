import type { Node as TsNode } from '@vscode/tree-sitter-wasm'

/** Utilidades sobre el árbol de tree-sitter que comparten el analizador y el extractor semántico. */

export const field = (node: TsNode, name: string): TsNode | null => node.childForFieldName(name)

export const firstLine = (text: string) => text.split('\n')[0]?.trim() ?? ''

/** Nombre punteado de una llamada: `pd.read_csv` → "pd.read_csv". */
export function calleeName(call: TsNode): string {
  return field(call, 'function')?.text ?? ''
}

/** Los hijos con nombre de un nodo, sin los huecos que tree-sitter puede devolver. */
export function named(node: TsNode): TsNode[] {
  return node.namedChildren.filter((child): child is TsNode => child !== null)
}

const COMPREHENSIONS = new Set([
  'list_comprehension',
  'set_comprehension',
  'dictionary_comprehension',
  'generator_expression',
])

/** Todos los identificadores que aparecen dentro de un patrón (`a`, `a, b`, `(a, b)`). */
function identifiersIn(node: TsNode | null): string[] {
  if (!node) return []
  if (node.type === 'identifier') return [node.text]
  return named(node).flatMap(identifiersIn)
}

/**
 * Cada vez que una expresión **lee una variable**, con el nodo donde lo hace.
 *
 * No es lo mismo que «cada identificador»: de `pd.read_csv` se lee `pd`, no `read_csv`; en
 * `f(tope=3)`, `tope` es el nombre de un argumento y no una variable; y en `[x for x in xs]` la
 * `x` es local de la comprensión, no la `x` de fuera. Confundirlos daría conexiones falsas y,
 * peor, renombraría por error lo que no toca.
 */
export function readIdentifiers(expression: TsNode | null): TsNode[] {
  const found: TsNode[] = []
  const walk = (node: TsNode, hidden: ReadonlySet<string>) => {
    switch (node.type) {
      case 'identifier':
        if (!hidden.has(node.text)) found.push(node)
        return
      case 'attribute': {
        const object = field(node, 'object')
        if (object) walk(object, hidden)
        return
      }
      case 'keyword_argument': {
        const value = field(node, 'value')
        if (value) walk(value, hidden)
        return
      }
      case 'lambda': {
        const local = new Set([...hidden, ...identifiersIn(field(node, 'parameters'))])
        const body = field(node, 'body')
        if (body) walk(body, local)
        return
      }
    }
    if (COMPREHENSIONS.has(node.type)) {
      const local = new Set(hidden)
      for (const child of named(node)) {
        if (child.type === 'for_in_clause') {
          for (const name of identifiersIn(field(child, 'left'))) local.add(name)
        }
      }
      for (const child of named(node)) walk(child, local)
      return
    }
    for (const child of named(node)) walk(child, hidden)
  }
  if (expression) walk(expression, new Set())
  return found
}

/** Identificadores que una expresión lee, en orden de aparición y sin repetir. */
export function readNames(expression: TsNode | null): string[] {
  return [...new Set(readIdentifiers(expression).map((node) => node.text))]
}

export function findFirst(node: TsNode, types: string[]): TsNode | null {
  if (types.includes(node.type)) return node
  for (const child of node.namedChildren) {
    if (!child) continue
    const found = findFirst(child, types)
    if (found) return found
  }
  return null
}
