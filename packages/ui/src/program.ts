import { useCallback, useMemo, useState } from 'react'
import {
  getKind,
  valueTypeOf,
  type ControlModel,
  type Density,
  type NodeKindId,
} from '@prysel/morphology'
import {
  channelOf,
  collapse,
  groupsFromContainers,
  type SemanticEdge,
  type SemanticGraph,
} from '@prysel/spatial'
import type { CanvasNode } from './Canvas.tsx'
import { isLoopTerritory } from './flow/frame.ts'

/**
 * Del programa analizado al lienzo. Es lo que comparten la extensión y la galería: los dos
 * reciben un programa del analizador y tienen que enseñarlo igual.
 *
 * Un programa se ve de dos maneras. El **programa** es el flujo del archivo, donde cada
 * función aparece una sola vez: como la llamada que la usa. Una **función** se ve aparte, en un
 * lienzo limpio con solo su contenido. Enseñar la definición *y* la llamada, en el mismo
 * plano, es decir dos veces lo mismo.
 */

/** Lo que la interfaz necesita saber de un nodo analizado. Estructural: `ui` no depende del analizador. */
export interface SourceNode {
  id: string
  kind: NodeKindId
  label: string
  code: string
  line: number
  contains?: string[]
  ops?: number
  control?: ControlModel
  /** De dónde sale cada campo del editor en el texto. Aquí solo importan los nombres: son los editables. */
  sources?: Record<string, unknown>
  /** El texto de la sentencia (o de su cabecera): lo que se edita como código. */
  text?: string
  /** Dónde aparece cada nombre que define este nodo. Aquí solo importa cuáles define. */
  names?: Record<string, unknown>
  /** Qué campos del editor son nombres que se pueden renombrar. */
  renames?: Record<string, string>
  /** El nombre que el nodo deja definido: lo que sale por su puerto de salida. */
  provides?: string
  /** Los parámetros de una función: cada uno es un puerto de salida hacia su interior. */
  params?: string[]
  /** Qué campos aceptan un cable. Aquí solo importa cuáles. */
  inputs?: Record<string, unknown>
  /** Los nombres que el nodo puede leer: lo definido antes, en su ámbito. */
  scope?: string[]
  /** Dónde está en el archivo: aquí solo importa qué sentencia lo posee (la función, el bucle o la decisión que lo envuelve). */
  range?: { owner?: string }
  calls?: string
  note?: string
}

/**
 * Cuando un nodo tiene editor, el código sobra: el editor dice toda la sentencia y el código
 * está en el archivo, a la vista, en la línea que indica el pie. Sin editor (algo que el
 * analizador no supo representar del todo) se enseña el código, que es lo honesto.
 */
/** Un nombre que Python admite para una variable o una función. */
const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u

export function toCanvasNodes(nodes: SourceNode[]): CanvasNode[] {
  // Los nombres que un nodo define, con su línea: las variables que están al alcance de lo que viene después.
  const defined = nodes.filter((n) => n.names?.[n.label] !== undefined && IDENTIFIER.test(n.label))
  return nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    ...(node.control ? { control: node.control } : { code: node.code }),
    // Un campo se puede escribir de vuelta si el analizador sabe dónde está en el texto, o si es
    // un nombre que se puede renombrar en todos sus usos.
    ...(node.control
      ? {
          editable: [
            ...Object.keys(node.sources ?? {}),
            ...Object.keys(node.renames ?? {}),
            // Si se puede reescribir la lista de parámetros, se puede dar un valor por defecto a cualquiera.
            ...(node.control.kind === 'signature' && node.sources?.['paramsList']
              ? node.control.params.map((param) => `params.${param.name}`)
              : []),
          ],
        }
      : {}),
    // Cualquier nodo se puede escribir como código; un título que es un nombre se puede renombrar.
    ...(node.text === undefined ? {} : { text: node.text }),
    line: node.line,
    ...(node.names?.[node.label] !== undefined && IDENTIFIER.test(node.label)
      ? { renamable: true }
      : {}),
    // Lo que se puede escribir en un campo: lo que el analizador dice que está al alcance del nodo
    // (sus variables, sus parámetros, lo definido antes) o, sin él, las variables anteriores.
    scope:
      node.scope ??
      [
        ...new Set(
          defined.filter((d) => d.line < node.line && d.id !== node.id).map((d) => d.label),
        ),
      ].slice(-40),
    // Lo que sale y lo que entra: es lo que se puede conectar arrastrando.
    ...(node.provides === undefined ? {} : { provides: node.provides }),
    ...(node.params && node.params.length > 0 ? { params: node.params } : {}),
    ...(node.inputs && Object.keys(node.inputs).length > 0
      ? { inputs: Object.keys(node.inputs) }
      : {}),
    valueType: valueTypeOf(node.kind, node.control),
    // Quién lo posee: decide si es una inicialización de su contexto (un chip) o parte del flujo.
    ...(node.range?.owner === undefined ? {} : { owner: node.range.owner }),
    // En lugar del chip de estado (no hay ejecución), se muestra la línea de origen.
    meta: `línea ${node.line}`,
    ...(node.ops === undefined ? {} : { metrics: { ops: node.ops } }),
    ...(node.contains ? { contains: node.contains } : {}),
    ...(node.note ? { note: node.note } : {}),
    // Una llamada a una función del archivo lleva a ella.
    ...(node.calls ? { opens: node.calls, openable: true } : {}),
  }))
}

/** Una función con cuerpo: es la que aparece en el menú «Funciones» y la que se ve aparte. */
function isFunction(node: CanvasNode): boolean {
  return getKind(node.kind).role === 'abstraction' && (node.contains?.length ?? 0) > 0
}

/** Un ámbito plegable: una función con cuerpo o un bucle con cuerpo (no una decisión). */
function isFoldable(node: CanvasNode): boolean {
  return isFunction(node) || isLoopTerritory(node)
}

export interface FunctionInfo {
  id: string
  name: string
  /** `(a, b)`: lo que la función recibe. */
  signature: string
  /** Los nombres de sus parámetros, en orden. */
  params: string[]
  /** Cuántas llamadas hay a ella en el archivo. */
  calls: number
  /**
   * Se usa: algo de fuera de su cuerpo depende de ella. Una función usada no se dibuja en el
   * programa (ya está en la llamada); una sin usar sí, porque si no, no se vería en ningún sitio.
   */
  used: boolean
  /** Cuántos nodos tiene dentro. */
  size: number
  /** Lo que la función dice de sí misma: su docstring y los comentarios que la explican. */
  doc?: string
}

export function functionsOf(nodes: CanvasNode[], edges: SemanticEdge[]): FunctionInfo[] {
  return nodes.filter(isFunction).map((node) => {
    const body = new Set(node.contains)
    const params =
      node.control?.kind === 'signature' ? node.control.params.map((p) => p.name).join(', ') : ''
    return {
      id: node.id,
      name: node.label,
      signature: `(${params})`,
      params: node.control?.kind === 'signature' ? node.control.params.map((p) => p.name) : [],
      calls: nodes.filter((other) => other.opens === node.id).length,
      used: edges.some((edge) => edge.from === node.id && !body.has(edge.to)),
      size: body.size,
      ...(node.note ? { doc: node.note } : {}),
    }
  })
}

export interface FoldedView {
  nodes: CanvasNode[]
  edges: SemanticEdge[]
}

/**
 * Lo que se ve del programa: o el flujo del archivo (`focus` nulo) o el contenido de una
 * función. Las definiciones usadas se quitan del flujo —su cuerpo se ve en su propio lienzo—
 * y una función enfocada enseña solo su interior, sin ella misma alrededor.
 */
export function programView(
  nodes: CanvasNode[],
  edges: SemanticEdge[],
  focus: string | null,
): FoldedView {
  const used = functionsOf(nodes, edges).filter((f) => f.used && f.id !== focus)
  const hidden = new Set<string>()
  for (const fn of used) {
    hidden.add(fn.id)
    for (const id of nodes.find((n) => n.id === fn.id)?.contains ?? []) hidden.add(id)
  }

  // La función enfocada se ve como un territorio que envuelve su cuerpo: es donde están sus
  // parámetros, los puertos desde los que se cablea lo que hay dentro.
  const inside =
    focus === null
      ? null
      : new Set([focus, ...(nodes.find((node) => node.id === focus)?.contains ?? [])])
  const visible = (id: string) => !hidden.has(id) && (inside === null || inside.has(id))

  return {
    nodes: nodes.filter((node) => visible(node.id)),
    edges: edges.filter((edge) => visible(edge.from) && visible(edge.to)),
  }
}

/**
 * Pliega los ámbitos indicados: cada uno pasa a ser un solo nodo, y las conexiones que
 * cruzaban su borde entran y salen de él. Es la vista de pájaro de la arquitectura:
 * qué recibe cada función y qué devuelve, sin su lógica interna.
 */
export function foldScopes(
  nodes: CanvasNode[],
  edges: SemanticEdge[],
  folded: ReadonlySet<string>,
): FoldedView {
  const graph: SemanticGraph = {
    nodes: nodes.map((node) => ({
      id: node.id,
      role: getKind(node.kind).role,
      size: { w: 0, h: 0 },
      ...(node.contains ? { contains: node.contains } : {}),
    })),
    edges,
  }
  const groups = groupsFromContainers(graph).filter((group) => folded.has(group.id))
  const result = collapse(graph, groups)
  const kept = new Set(result.graph.nodes.map((n) => n.id))

  return {
    nodes: nodes
      .filter((node) => kept.has(node.id))
      // Plegada o abierta, una función se puede recorrer: el nodo lo dice para dar su chevron.
      .map((node) => (isFoldable(node) ? { ...node, openable: true } : node)),
    edges: result.graph.edges,
  }
}

/**
 * El retorno de una función no es un nodo más: es **la salida de la función**. Un `return suma` que
 * solo devuelve una variable no se dibuja: el cable va de donde se calcula `suma` directamente al
 * puerto de retorno de la función, y eso ya dice que ese valor es lo que devuelve. Un `return a + b`
 * es una operación: se dibuja como tal, con su salida al puerto de retorno.
 *
 * Los retornos que son el destino de una decisión o de un bucle se quedan (perderían el cable de
 * control que los alcanza), y una función cuyo cuerpo sería solo su retorno también: sin nada
 * dentro no habría territorio.
 */
export function foldReturns(nodes: CanvasNode[], edges: SemanticEdge[]): FoldedView {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const hiddenIn = new Map<string, string>()
  const patched = new Map<string, CanvasNode>()
  const added: SemanticEdge[] = []

  for (const def of nodes) {
    if (def.kind !== 'abstraction.collapsed') continue
    const body = (def.contains ?? []).filter((id) => byId.has(id))
    if (body.length === 0) continue

    const returns = body.flatMap((id) => {
      const node = byId.get(id)
      return node?.kind === 'control.return' ? [node] : []
    })
    const simple = new Set(
      returns
        .filter((node) => {
          const control = node.control
          if (control?.kind !== 'args' || control.args.length !== 1) return false
          if (!IDENTIFIER.test(control.args[0]?.value.trim() ?? '')) return false
          const incoming = edges.filter((edge) => edge.to === node.id)
          return (
            incoming.length > 0 &&
            incoming.every((edge) => edge.toPort === 'arg:valor' && channelOf(edge) === 'data')
          )
        })
        .map((node) => node.id),
    )
    // Sin nada más dentro, no habría territorio: se quedan a la vista.
    if (body.every((id) => simple.has(id))) simple.clear()

    for (const id of simple) hiddenIn.set(id, def.id)
    for (const node of returns) {
      if (simple.has(node.id)) continue
      const operation = node.control?.kind === 'expression'
      patched.set(node.id, {
        ...node,
        returns: def.id,
        ...(operation ? { kind: 'transform.operation' as const, label: 'devuelve' } : {}),
      })
      added.push({ from: node.id, to: def.id, relation: 'transform', toPort: 'return' })
    }
    patched.set(def.id, {
      ...def,
      inputs: [...(def.inputs ?? []), 'return'],
      contains: def.contains?.filter((id) => byId.has(id) && !simple.has(id)) ?? [],
    })
  }

  return {
    nodes: nodes
      .filter((node) => !hiddenIn.has(node.id))
      .map((node) => patched.get(node.id) ?? node),
    edges: [
      ...edges.flatMap((edge) => {
        if (hiddenIn.has(edge.from)) return []
        const def = hiddenIn.get(edge.to)
        return [def === undefined ? edge : { ...edge, to: def, toPort: 'return', via: edge.to }]
      }),
      ...added,
    ],
  }
}

const NONE: ReadonlySet<string> = new Set()
const PROGRAM = 'programa'

export interface ProgramView extends FoldedView {
  /** Todas las funciones del archivo: es lo que lista el menú. */
  functions: FunctionInfo[]
  /** La función que se está viendo, o `null` si es el programa. */
  focus: FunctionInfo | null
  /** Ir a una función (o volver al programa con `null`). */
  open: (id: string | null) => void
  /** Lo que hace el chevron de un nodo: una llamada abre su función; una función se pliega o se abre. */
  enter: (id: string) => void
  /** Cuántos ámbitos hay plegados ahora. */
  folded: number
  /** Cambia con lo que se ve: es la señal para que el lienzo se reencuadre. */
  viewKey: string
}

/**
 * Qué se ve y cómo. **Compacto pliega todas las funciones**: es la vista de pájaro, y su razón de
 * ser es que el programa quepa en una mirada. Normal y expandido las abren. El usuario puede
 * darle la vuelta a cualquiera; cambiar de densidad vuelve a lo de serie, porque es una decisión
 * de «cuánto quiero ver» y no de una función concreta.
 */
export function useProgramView(
  nodes: CanvasNode[],
  edges: SemanticEdge[],
  density: Density,
): ProgramView {
  const mode = density === 'compact' ? 'compact' : 'open'
  const [focusId, setFocusId] = useState<string | null>(null)
  const [state, setState] = useState<{ mode: string; flipped: ReadonlySet<string> }>({
    mode,
    flipped: NONE,
  })
  const flipped = state.mode === mode ? state.flipped : NONE

  const functions = useMemo(() => functionsOf(nodes, edges), [nodes, edges])
  // Si la función enfocada desaparece (se borró del código), se vuelve al programa.
  const focus = useMemo(
    () => functions.find((fn) => fn.id === focusId) ?? null,
    [functions, focusId],
  )

  const base = useMemo(() => programView(nodes, edges, focus?.id ?? null), [nodes, edges, focus])
  // La función que se está viendo nunca se pliega: sería quedarse sin ver lo que se pidió ver.
  const scopes = useMemo(
    () =>
      base.nodes.filter((node) => isFoldable(node) && node.id !== focus?.id).map((node) => node.id),
    [base, focus],
  )
  const foldedSet = useMemo(
    () => new Set(scopes.filter((id) => (mode === 'compact') !== flipped.has(id))),
    [scopes, mode, flipped],
  )
  const view = useMemo(() => {
    const folded = foldScopes(base.nodes, base.edges, foldedSet)
    return foldReturns(folded.nodes, folded.edges)
  }, [base, foldedSet])

  const toggle = useCallback(
    (id: string) => {
      setState((previous) => {
        const from = previous.mode === mode ? previous.flipped : NONE
        const next = new Set(from)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return { mode, flipped: next }
      })
    },
    [mode],
  )

  const enter = useCallback(
    (id: string) => {
      const target = nodes.find((node) => node.id === id)
      if (target?.opens) setFocusId(target.opens)
      else toggle(id)
    },
    [nodes, toggle],
  )

  return {
    ...view,
    functions,
    focus,
    open: setFocusId,
    enter,
    folded: foldedSet.size,
    viewKey: focus?.id ?? PROGRAM,
  }
}
