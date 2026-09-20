import { useCallback, useMemo, useState } from 'react'
import { getKind, type ControlModel, type Density, type NodeKindId } from '@prysel/morphology'
import {
  collapse,
  groupsFromContainers,
  type SemanticEdge,
  type SemanticGraph,
} from '@prysel/spatial'
import type { CanvasNode } from './Canvas.tsx'

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
  calls?: string
}

/**
 * Cuando un nodo tiene editor, el código sobra: el editor dice toda la sentencia y el código
 * está en el archivo, a la vista, en la línea que indica el pie. Sin editor (algo que el
 * analizador no supo representar del todo) se enseña el código, que es lo honesto.
 */
export function toCanvasNodes(nodes: SourceNode[]): CanvasNode[] {
  return nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    ...(node.control ? { control: node.control } : { code: node.code }),
    // En lugar del chip de estado (no hay ejecución), se muestra la línea de origen.
    meta: `línea ${node.line}`,
    ...(node.ops === undefined ? {} : { metrics: { ops: node.ops } }),
    ...(node.contains ? { contains: node.contains } : {}),
    // Una llamada a una función del archivo lleva a ella.
    ...(node.calls ? { opens: node.calls, openable: true } : {}),
  }))
}

/** Un ámbito plegable: una abstracción con cuerpo (una función), no un bucle ni una decisión. */
function isFoldable(node: CanvasNode): boolean {
  return getKind(node.kind).role === 'abstraction' && (node.contains?.length ?? 0) > 0
}

export interface FunctionInfo {
  id: string
  name: string
  /** `(a, b)`: lo que la función recibe. */
  signature: string
  /** Cuántas llamadas hay a ella en el archivo. */
  calls: number
  /**
   * Se usa: algo de fuera de su cuerpo depende de ella. Una función usada no se dibuja en el
   * programa (ya está en la llamada); una sin usar sí, porque si no, no se vería en ningún sitio.
   */
  used: boolean
  /** Cuántos nodos tiene dentro. */
  size: number
}

export function functionsOf(nodes: CanvasNode[], edges: SemanticEdge[]): FunctionInfo[] {
  return nodes.filter(isFoldable).map((node) => {
    const body = new Set(node.contains)
    const params =
      node.control?.kind === 'signature' ? node.control.params.map((p) => p.name).join(', ') : ''
    return {
      id: node.id,
      name: node.label,
      signature: `(${params})`,
      calls: nodes.filter((other) => other.opens === node.id).length,
      used: edges.some((edge) => edge.from === node.id && !body.has(edge.to)),
      size: body.size,
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

  const inside =
    focus === null ? null : new Set(nodes.find((node) => node.id === focus)?.contains ?? [])
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
  const scopes = useMemo(() => base.nodes.filter(isFoldable).map((node) => node.id), [base])
  const foldedSet = useMemo(
    () => new Set(scopes.filter((id) => (mode === 'compact') !== flipped.has(id))),
    [scopes, mode, flipped],
  )
  const view = useMemo(() => foldScopes(base.nodes, base.edges, foldedSet), [base, foldedSet])

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
