import type { Program, ProgramNode } from '@prysel/python'

/**
 * Qué ejecutar y en qué orden. El motor ejecuta **sentencias de primer nivel**: una función, un
 * bucle o una decisión se ejecutan enteros, con todo lo que llevan dentro. El grafo dice de qué
 * depende cada una, y de ahí salen dos cosas que un notebook no tiene: ejecutar un nodo trae antes
 * lo que necesita y aún no está al día, y tras editar se sabe qué resultados dejaron de valer.
 *
 * Es puro (sin `vscode` ni motor): se prueba con un programa y sus registros de ejecución.
 */

/** Una sentencia de primer nivel: lo que el motor ejecuta de una vez. */
export interface Statement {
  /** El id del nodo que la representa en el grafo. */
  id: string
  /** Su primera línea en el archivo (base 1). */
  line: number
  code: string
  /** Cambia cuando cambia el texto: es lo que dice que un resultado ya no vale. */
  hash: string
  /** De qué otras sentencias (por id) depende, en el orden del archivo. */
  deps: string[]
  /** Los nombres que deja definidos, para enseñarlos. */
  names: string[]
}

/** Un hash corto y estable del texto (FNV-1a): suficiente para reconocer una sentencia sin cambios. */
export function hashOf(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** A qué sentencia de primer nivel pertenece cada nodo (él mismo, si lo es). */
export function topLevelOf(program: Program): Map<string, string> {
  const byId = new Map(program.nodes.map((node) => [node.id, node]))
  const top = new Map<string, string>()
  const resolve = (node: ProgramNode): string | undefined => {
    const known = top.get(node.id)
    if (known !== undefined) return known
    if (!node.range) return undefined
    const owner = node.range.owner === undefined ? undefined : byId.get(node.range.owner)
    const found = owner ? resolve(owner) : node.id
    if (found !== undefined) top.set(node.id, found)
    return found
  }
  for (const node of program.nodes) resolve(node)
  return top
}

const namesOf = (node: ProgramNode): string[] =>
  node.results ?? (node.provides === undefined ? [] : [node.provides])

/** El nombre que entra por una conexión: el de un resultado entre varios, o el que define su origen. */
function nameThrough(from: ProgramNode, fromPort: string | undefined): string | undefined {
  if (fromPort?.startsWith('result:')) return fromPort.slice('result:'.length)
  if (fromPort?.startsWith('param:')) return undefined
  return from.provides
}

/**
 * Las sentencias de primer nivel del programa, en el orden del archivo, con lo que cada una necesita.
 *
 * Una sentencia depende de otra si alguno de sus nodos lee algo que define un nodo de la otra. Y
 * también de las que **mutan** eso que lee: `pred = model.predict(X)` necesita que `model.fit(X)` ya
 * haya corrido, aunque `fit` no defina ningún nombre. Un mutador es una llamada sin resultado cuyo
 * receptor es el valor que otro nodo define.
 */
export function statements(program: Program, source: string): Statement[] {
  const top = topLevelOf(program)
  const byId = new Map(program.nodes.map((node) => [node.id, node]))
  const start = (node: ProgramNode) => node.range?.start ?? 0

  const roots = program.nodes
    .filter((node) => node.range && top.get(node.id) === node.id)
    .sort((a, b) => start(a) - start(b))
  const deps = new Map<string, Set<string>>(roots.map((node) => [node.id, new Set()]))
  const link = (from: string, to: string) => {
    const a = top.get(from)
    const b = top.get(to)
    if (a !== undefined && b !== undefined && a !== b) deps.get(b)?.add(a)
  }

  // Quién muta cada valor: los nodos sin resultado cuyo receptor (la entrada principal) lo define otro.
  const mutators = new Map<string, ProgramNode[]>()
  const reads = program.edges.filter((edge) => edge.relation !== 'sequence')
  for (const edge of reads) {
    const target = byId.get(edge.to)
    const from = byId.get(edge.from)
    if (!target || !from || edge.relation !== 'transform') continue
    if (namesOf(target).length > 0 || target.kind === 'control.return') continue
    const name = nameThrough(from, edge.fromPort)
    if (name === undefined) continue
    const key = `${from.id}|${name}`
    mutators.set(key, [...(mutators.get(key) ?? []), target])
  }

  for (const edge of reads) {
    if (edge.relation === 'feedback') continue
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    link(edge.from, edge.to)
    const name = nameThrough(from, edge.fromPort)
    if (name === undefined) continue
    for (const mutator of mutators.get(`${from.id}|${name}`) ?? []) {
      // Solo los que ocurren antes de quien lee: lo que viene después no le afecta.
      if (mutator.id !== to.id && start(mutator) < start(to)) link(mutator.id, to.id)
    }
  }
  // Llamar a una función del archivo depende de que esté definida.
  for (const node of program.nodes) if (node.calls) link(node.calls, node.id)

  const order = new Map(roots.map((node, index) => [node.id, index]))
  return roots.map((node) => {
    const code = source.slice(node.range?.start ?? 0, node.range?.end ?? 0)
    return {
      id: node.id,
      line: node.line,
      code,
      hash: hashOf(code),
      deps: [...(deps.get(node.id) ?? [])].sort(
        (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
      ),
      names: namesOf(node),
    }
  })
}

/** Cómo está un resultado respecto al texto y a lo que depende de él. */
export type Freshness = 'never' | 'fresh' | 'stale' | 'error'

/** Lo mínimo que se guarda de una ejecución para saber si sigue valiendo. */
export interface Ran {
  hash: string
  /** El orden global de ejecución: quien depende de algo que corrió después ya no está al día. */
  seq: number
  ok: boolean
}

/**
 * Cómo está cada sentencia. `fresh`: se ejecutó con este texto y nada de lo que lee cambió después.
 * `stale`: se ejecutó, pero algo cambió (su texto o lo que necesita). `never`: nunca se ejecutó con
 * este texto. `error`: su última ejecución falló y nada ha cambiado desde entonces.
 */
export function freshness(
  stmts: readonly Statement[],
  records: ReadonlyMap<string, Ran>,
): Map<string, Freshness> {
  const state = new Map<string, Freshness>()
  for (const stmt of stmts) {
    const ran = records.get(stmt.id)
    if (!ran || ran.hash !== stmt.hash) {
      state.set(stmt.id, 'never')
      continue
    }
    const behind = stmt.deps.some((dep) => {
      const depRan = records.get(dep)
      return state.get(dep) !== 'fresh' || (depRan !== undefined && depRan.seq > ran.seq)
    })
    state.set(stmt.id, behind ? 'stale' : ran.ok ? 'fresh' : 'error')
  }
  return state
}

/**
 * Qué ejecutar para llevar `targets` al día: ellos (siempre, aunque estén al día: se pidió) y, antes,
 * todo lo que necesitan y no está al día. En el orden del archivo, que es el de Python.
 */
export function planRun(
  stmts: readonly Statement[],
  targets: readonly string[],
  state: ReadonlyMap<string, Freshness>,
): string[] {
  const byId = new Map(stmts.map((stmt) => [stmt.id, stmt]))
  const wanted = new Set<string>()
  const visit = (id: string, requested: boolean) => {
    if (wanted.has(id)) return
    const stmt = byId.get(id)
    if (!stmt) return
    if (!requested && state.get(id) === 'fresh') return
    wanted.add(id)
    for (const dep of stmt.deps) visit(dep, false)
  }
  for (const id of targets) visit(id, true)
  return stmts.filter((stmt) => wanted.has(stmt.id)).map((stmt) => stmt.id)
}

/** Todo, en orden: lo que hace «ejecutar todo». */
export const planAll = (stmts: readonly Statement[]): string[] => stmts.map((stmt) => stmt.id)

/**
 * Tras editar, cada registro sigue a su sentencia aunque cambie de sitio (se insertó una línea encima,
 * y los ids, que llevan la línea, se movieron): se reasocia por el texto. Lo que se editó no tiene
 * registro y vuelve a «nunca ejecutado». Entre sentencias con el mismo texto, se respeta el orden.
 */
export function reconcile<R extends { hash: string }>(
  records: ReadonlyMap<string, R>,
  previous: readonly Pick<Statement, 'id' | 'hash'>[],
  next: readonly Pick<Statement, 'id' | 'hash'>[],
): Map<string, R> {
  const queues = new Map<string, R[]>()
  for (const stmt of previous) {
    const record = records.get(stmt.id)
    if (record) queues.set(stmt.hash, [...(queues.get(stmt.hash) ?? []), record])
  }
  const kept = new Map<string, R>()
  for (const stmt of next) {
    const record = queues.get(stmt.hash)?.shift()
    if (record) kept.set(stmt.id, record)
  }
  return kept
}

/** La línea del archivo donde falló un fragmento que empieza en `line`, a partir de la línea dentro de él. */
export const fileLine = (startLine: number, inFragment: number | null): number | null =>
  inFragment === null ? null : startLine + inFragment - 1
