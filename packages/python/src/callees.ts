import type { Node as TsNode } from '@vscode/tree-sitter-wasm'
import type { ProgramNode } from './program.ts'
import { field } from './tree.ts'

/**
 * A qué funciones del propio archivo llama cada sentencia: sus **subprocesos**.
 *
 * Un algoritmo se reparte en funciones, y lo que las une son las llamadas. Muchas no son una sentencia
 * suelta (`entrenar()`): van metidas en una comprensión (`[volar(g) for g in poblacion]`), anidadas
 * (`mutar(cruzar(madre, padre))`) o son métodos de un objeto (`pajaro.decidir(…)`). Aquí se recogen
 * todas las que aparecen en el texto propio de cada sentencia —en una compuesta, solo su cabecera: su
 * cuerpo son otras sentencias— y se resuelven **al final**, con todas las definiciones ya vistas, así que
 * valen también para una función definida más abajo.
 *
 * Lo que no se puede saber sin ejecutar (un objeto que llega por un parámetro) no se inventa: se queda
 * sin subproceso.
 */

interface CallAt {
  start: number
  end: number
  /** `volar(…)`: el nombre llamado. */
  name?: string
  /** `pajaro.decidir(…)`: el objeto y el método. */
  object?: string
  attribute?: string
}

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u
/** `x = Clase(…)`: el nombre que pasa a ser una instancia, y de qué. */
const INSTANCE = /^([\p{L}_][\p{L}\p{N}_]*)\s*=\s*([\p{L}_][\p{L}\p{N}_]*)\s*\(/u

/** Todas las llamadas del árbol, en el orden del texto. */
function callsIn(root: TsNode): CallAt[] {
  const found: CallAt[] = []
  const stack: TsNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) continue
    if (node.type === 'call') {
      const fn = field(node, 'function')
      if (fn?.type === 'identifier') {
        found.push({ start: node.startIndex, end: node.endIndex, name: fn.text })
      } else if (fn?.type === 'attribute') {
        const object = field(fn, 'object')
        const attribute = field(fn, 'attribute')
        if (object && attribute && IDENTIFIER.test(object.text)) {
          found.push({
            start: node.startIndex,
            end: node.endIndex,
            object: object.text,
            attribute: attribute.text,
          })
        }
      }
    }
    const children = node.namedChildren
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (child) stack.push(child)
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

/** Apunta en cada nodo (`callees`) las funciones, clases y métodos del archivo a los que llama. */
export function linkCallees(root: TsNode, nodes: ProgramNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const ownerOf = (node: ProgramNode) =>
    node.range?.owner === undefined ? undefined : byId.get(node.range.owner)
  /** El más cercano de los que envuelven a un nodo que cumple algo (sin contarlo a él). */
  const enclosing = (node: ProgramNode, test: (n: ProgramNode) => boolean) => {
    let up = ownerOf(node)
    for (let guard = 0; up && guard < 64; guard++) {
      if (test(up)) return up
      up = ownerOf(up)
    }
    return undefined
  }
  const isClass = (node: ProgramNode) => node.kind === 'abstraction.class'
  const isDef = (node: ProgramNode) => node.kind === 'abstraction.collapsed'

  const functions = new Map<string, string>()
  const classes = new Map<string, string>()
  const methods = new Map<string, Map<string, string>>()
  for (const node of nodes) {
    if (isClass(node) && !classes.has(node.label)) classes.set(node.label, node.id)
    if (!isDef(node)) continue
    const owner = ownerOf(node)
    if (owner && isClass(owner)) {
      const own = methods.get(owner.id) ?? new Map<string, string>()
      if (!own.has(node.label)) own.set(node.label, node.id)
      methods.set(owner.id, own)
    } else if (!functions.has(node.label)) functions.set(node.label, node.id)
  }

  /** Qué nombres son instancias de una clase del archivo, por ámbito (la función que los define, o el módulo). */
  const MODULE = ''
  const instances = new Map<string, Map<string, string>>()
  for (const node of nodes) {
    const match = INSTANCE.exec(node.text ?? '')
    const cls = match?.[2] === undefined ? undefined : classes.get(match[2])
    if (!match?.[1] || cls === undefined) continue
    const scope = enclosing(node, isDef)?.id ?? MODULE
    const own = instances.get(scope) ?? new Map<string, string>()
    own.set(match[1], cls)
    instances.set(scope, own)
  }

  const resolve = (call: CallAt, node: ProgramNode): string | undefined => {
    if (call.name !== undefined) return functions.get(call.name) ?? classes.get(call.name)
    if (call.object === undefined || call.attribute === undefined) return undefined
    let cls: string | undefined
    if (call.object === 'self' || call.object === 'cls') cls = enclosing(node, isClass)?.id
    else if (classes.has(call.object)) cls = classes.get(call.object)
    else {
      const scope = enclosing(node, isDef)?.id ?? MODULE
      cls = instances.get(scope)?.get(call.object) ?? instances.get(MODULE)?.get(call.object)
    }
    return cls === undefined ? undefined : methods.get(cls)?.get(call.attribute)
  }

  const calls = callsIn(root)
  for (const node of nodes) {
    const range = node.range
    if (!range) continue
    // Una sentencia compuesta llama a lo que llama su cabecera: lo de su cuerpo son otras sentencias.
    const end = range.head ?? range.end
    const own: CallAt[] = []
    for (const call of calls) {
      if (call.start < range.start) continue
      if (call.start >= end) break
      own.push(call)
    }
    // En el orden en que se ejecutan: en `mutar(cruzar(a, b))`, primero `cruzar` (acaba antes).
    const ids: string[] = []
    for (const call of own.sort((a, b) => a.end - b.end)) {
      const id = resolve(call, node)
      if (id !== undefined && !ids.includes(id)) ids.push(id)
    }
    if (ids.length > 0) node.callees = ids
  }
}
