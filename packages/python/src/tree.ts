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

/** Identificadores que una expresión lee, en orden de aparición y sin repetir. */
export function readNames(expression: TsNode | null): string[] {
  if (!expression) return []
  const names: string[] = []
  const walk = (node: TsNode) => {
    if (node.type === 'identifier') {
      const name = node.text
      if (!names.includes(name)) names.push(name)
      return
    }
    // De `pd.read_csv` interesa `pd`, no el atributo.
    if (node.type === 'attribute') {
      const object = field(node, 'object')
      if (object) walk(object)
      return
    }
    for (const child of node.namedChildren) if (child) walk(child)
  }
  walk(expression)
  return names
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
