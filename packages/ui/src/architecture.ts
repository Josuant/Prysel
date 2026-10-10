import { getKind } from '@prysel/morphology'
import {
  channelOf,
  defaultShape,
  shapeCandidates,
  type ArchGraph,
  type ArchLink,
  type ArchModule,
  type Architecture,
  type ModuleRole,
  type SemanticEdge,
} from '@prysel/spatial'
import type { CanvasNode } from './Canvas.tsx'

/**
 * La arquitectura de un programa, **sacada de su análisis**: qué módulos tiene (sus etapas de primer nivel) y
 * qué los une de verdad — un dato que uno deja y otro usa, o una función de uno a la que otro llama.
 *
 * Nada de esto lo dice una IA: son las conexiones que el analizador ya resolvió, recogidas en el borde de cada
 * módulo. El papel de cada uno (entrada, datos, lógica, control, salida) se estima aquí con lo que hace su
 * código; quien tenga mejor criterio (el JEV) puede corregirlo.
 */

/** Lo que el código de un módulo hace, mirado desde fuera: de aquí sale su papel. */
export interface ModuleFacts {
  id: string
  title: string
  /** Pide datos por teclado. */
  asks: boolean
  /** Escribe en pantalla. */
  prints: boolean
  /** Solo define funciones o clases. */
  defines: boolean
  /** Solo guarda valores (ni llama a nadie ni decide nada). */
  stores: boolean
  /** Repite algo en su primer nivel. */
  loops: boolean
  /** Dentro de lo que repite, decide entre caminos. */
  branches: boolean
  /** A cuántos de los demás módulos llama. */
  calls: number
  /** De qué línea a qué línea va en el archivo. */
  line: number
  lineEnd: number
}

const ASKS = /\binput\s*\(/

/** El papel que el código de un módulo deja ver. */
export function roleOf(facts: ModuleFacts): ModuleRole {
  // Quien repite llamando a otros, o no hace más que repartir el trabajo entre varios, manda.
  if ((facts.loops && facts.calls >= 1) || (!facts.defines && facts.calls >= 2)) return 'control'
  if (facts.stores) return 'datos'
  if (facts.asks) return 'entrada'
  if (facts.prints) return 'salida'
  return 'logica'
}

/** El nombre del valor que viaja por una conexión de datos: lo que define su origen, o su parámetro. */
function valueName(edge: SemanticEdge, from: CanvasNode | undefined): string | undefined {
  const port = edge.fromPort
  if (port?.startsWith('param:')) return port.slice('param:'.length)
  if (port?.startsWith('result:')) return port.slice('result:'.length)
  return from?.provides
}

/** Varios nombres en una sola etiqueta: los dos primeros y cuántos más. */
const several = (names: readonly string[]) =>
  names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`

/**
 * Los módulos que se ven en el primer nivel y lo que los une. `view` es lo que el lienzo dibuja (de ahí sale
 * qué etapas están arriba del todo); `all`, el programa entero con sus etapas (`withSections`), de donde sale
 * lo que cada módulo tiene dentro aunque esté plegado.
 */
export function moduleGraph(
  view: readonly CanvasNode[],
  all: readonly CanvasNode[],
  edges: readonly SemanticEdge[],
): { graph: ArchGraph; facts: ModuleFacts[] } {
  const inner = new Set(view.flatMap((node) => node.contains ?? []))
  const tops = view.filter((node) => node.section !== undefined && !inner.has(node.id))
  const byId = new Map(all.map((node) => [node.id, node]))
  const owned = new Map<string, string[]>()
  for (const node of all) {
    if (node.owner !== undefined) owned.set(node.owner, [...(owned.get(node.owner) ?? []), node.id])
  }
  const deep = (roots: readonly string[]): Set<string> => {
    const found = new Set<string>()
    const walk = (id: string) => {
      if (found.has(id)) return
      found.add(id)
      for (const child of byId.get(id)?.contains ?? []) walk(child)
      for (const child of owned.get(id) ?? []) walk(child)
    }
    for (const id of roots) walk(id)
    return found
  }
  /** Las sentencias de su primer nivel: las de la etapa, o el bucle que la encabeza. */
  const membersOf = (node: CanvasNode) =>
    node.kind === 'space.section' ? [...(node.section?.members ?? [])] : [node.id]
  const inside = new Map(tops.map((node) => [node.id, deep(membersOf(node))]))
  const moduleOf = new Map<string, string>()
  for (const [module, ids] of inside) {
    for (const id of ids) if (!moduleOf.has(id)) moduleOf.set(id, module)
  }

  // Lo que los une. Varios datos (o varias funciones) entre los mismos dos módulos son una sola flecha.
  const found = new Map<string, { link: ArchLink; names: string[] }>()
  const add = (from: string, to: string, kind: ArchLink['kind'], name: string | undefined) => {
    if (from === to) return
    const key = `${kind}|${from}|${to}`
    const entry = found.get(key) ?? { link: { from, to, kind }, names: [] }
    if (name !== undefined && !entry.names.includes(name)) entry.names.push(name)
    found.set(key, entry)
  }
  for (const edge of edges) {
    if (channelOf(edge) !== 'data') continue
    const from = moduleOf.get(edge.from)
    const to = moduleOf.get(edge.to)
    if (from === undefined || to === undefined) continue
    const source = byId.get(edge.from)
    const kind = source?.kind ?? 'opaque.code'
    if (kind === 'external.import') continue
    // Lo que sale de una función (que no sea un parámetro) es su nombre: quien lo recibe la está usando.
    if (getKind(kind).role === 'abstraction' && !edge.fromPort?.startsWith('param:')) {
      add(to, from, 'call', source?.label)
    } else {
      add(from, to, 'data', valueName(edge, source))
    }
  }
  for (const node of all) {
    const from = moduleOf.get(node.id)
    if (from === undefined) continue
    for (const sub of node.subprocesses ?? []) {
      const to = moduleOf.get(sub.id)
      if (to !== undefined) add(from, to, 'call', sub.name)
    }
  }
  const links = [...found.values()].map(({ link, names }) =>
    names.length > 0 ? { ...link, label: several(names) } : link,
  )

  const facts = tops.map((top): ModuleFacts => {
    const own = [...(inside.get(top.id) ?? [])].flatMap((id) => byId.get(id) ?? [])
    const members = membersOf(top).flatMap((id) => byId.get(id) ?? [])
    // Lo que repite: un bucle suyo, o el de la función que define (un `def correr()` con su `while` dentro).
    const loop =
      members.find((node) => node.kind === 'control.loop') ??
      members
        .filter((node) => getKind(node.kind).role === 'abstraction')
        .flatMap((node) => (node.contains ?? []).flatMap((id) => byId.get(id) ?? []))
        .find((node) => node.kind === 'control.loop')
    const looped = loop ? deep([loop.id]) : new Set<string>()
    return {
      id: top.id,
      title: top.section?.title ?? top.label,
      line: top.line ?? 0,
      lineEnd: top.lineEnd ?? top.line ?? 0,
      asks: own.some((node) => ASKS.test(node.code ?? node.text ?? '')),
      prints: own.some((node) => node.kind === 'effect.io' || node.kind === 'output.display'),
      defines:
        members.length > 0 && members.every((node) => getKind(node.kind).role === 'abstraction'),
      stores:
        own.length > 0 &&
        own.every((node) => {
          const role = getKind(node.kind).role
          return (role === 'value' || role === 'data') && (node.subprocesses ?? []).length === 0
        }),
      loops: loop !== undefined,
      branches: [...looped].some((id) => byId.get(id)?.kind === 'control.condition'),
      calls: links.filter((link) => link.kind === 'call' && link.from === top.id).length,
    }
  })
  const modules = facts.map((fact): ArchModule => ({
    id: fact.id,
    role: roleOf(fact),
    ...(fact.loops ? { loop: true } : {}),
    ...(fact.branches ? { branches: true } : {}),
  }))
  return { graph: { modules, links }, facts }
}

/**
 * La arquitectura con la que se dibuja el programa si nadie dice otra cosa: sus módulos y sus flechas de
 * verdad, y la forma que más dice de las que el grafo tiene. `null` si no hay al menos dos módulos (un
 * programa sin etapas se lee como siempre).
 */
export function architectureOf(
  view: readonly CanvasNode[],
  all: readonly CanvasNode[],
  edges: readonly SemanticEdge[],
): Architecture | null {
  return described(view, all, edges).architecture
}

/** La arquitectura y, de cada módulo, lo que su código deja ver (para quien quiera juzgar su papel). */
export function described(
  view: readonly CanvasNode[],
  all: readonly CanvasNode[],
  edges: readonly SemanticEdge[],
): { architecture: Architecture | null; facts: ModuleFacts[] } {
  const { graph, facts } = moduleGraph(view, all, edges)
  if (graph.modules.length < 2) return { architecture: null, facts }
  return { architecture: { ...graph, ...defaultShape(graph) }, facts }
}

/** Un módulo del plan: cómo se llama y de cuáles de los otros necesita algo. */
export interface PlannedModule {
  title: string
  needs: readonly string[]
}

const plainTitle = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * La arquitectura con lo que **el plan prometió** de los módulos que aún no tienen código (`pending`): de
 * quién necesita algo cada uno, como una flecha planeada. Un módulo ya escrito no lleva nada del plan: de él
 * manda el análisis. La forma se vuelve a elegir con lo que hay.
 */
export function withPlan(
  architecture: Architecture,
  facts: readonly ModuleFacts[],
  plan: readonly PlannedModule[],
  pending: ReadonlySet<string>,
): Architecture {
  const byTitle = new Map(facts.map((fact) => [plainTitle(fact.title), fact.id]))
  const find = (title: string) => {
    const wanted = plainTitle(title)
    if (wanted === '') return undefined
    const exact = byTitle.get(wanted)
    if (exact !== undefined) return exact
    // El plan dice «la lista» y el módulo se llama «Lista de gastos»: vale si uno contiene al otro.
    for (const [known, id] of byTitle) {
      if (known.includes(wanted) || wanted.includes(known)) return id
    }
    return undefined
  }
  const links = [...architecture.links]
  for (const module of plan) {
    const to = find(module.title)
    if (to === undefined || !pending.has(to)) continue
    for (const need of module.needs) {
      const from = find(need)
      if (from === undefined || from === to) continue
      const known = links.some(
        (link) => (link.from === from && link.to === to) || (link.from === to && link.to === from),
      )
      if (!known) links.push({ from, to, kind: 'data', planned: true })
    }
  }
  if (links.length === architecture.links.length) return architecture
  const graph = { modules: architecture.modules, links }
  return { ...graph, ...defaultShape(graph) }
}

/**
 * La arquitectura con lo que dijo quien sabe más (el JEV): el papel de cada módulo y, de las formas que el
 * grafo tiene de verdad, cuál lo cuenta mejor. Una forma que el grafo no tiene no se acepta.
 */
export function withVerdict(
  architecture: Architecture,
  verdict: {
    roles: Readonly<Record<string, ModuleRole | null | undefined>>
    shape?: string | null
  },
): Architecture {
  const modules = architecture.modules.map((module) => {
    const role = verdict.roles[module.id]
    return role ? { ...module, role } : module
  })
  const graph = { modules, links: architecture.links }
  const chosen = shapeCandidates(graph).find((candidate) => candidate.shape === verdict.shape)
  const { shape, anchor } = chosen ?? architecture
  return { ...graph, shape, ...(anchor === undefined ? {} : { anchor }) }
}

/**
 * La historia de una ejecución, ya dicha con módulos: el que lleva el bucle, los que pasan en cada vuelta (en
 * su orden), los de antes, y lo que viaja de uno a otro.
 */
export interface ModuleStory {
  anchor: string
  ring: readonly string[]
  before: readonly string[]
  flows: readonly { from: string; to: string; label: string }[]
  /** Lo que se dice en el centro del ciclo. */
  caption: string
  /** Cómo se salió del ciclo, con palabras: va en la marca de salida de quien lo lleva. */
  exit?: string
}

/**
 * La arquitectura **contada por lo que pasó**: un ciclo con sus pasos en el orden en que se ejecutan, lo que
 * viaja entre ellos como flechas de dato, y «luego» donde un paso sigue a otro sin pasarle nada. Lo que se
 * hace antes entra al primer paso. Las flechas de «quién llama a quién» se quitan salvo que se pidan
 * (`calls`): cuentan cómo está escrito, no cómo funciona.
 */
export function withStory(
  architecture: Architecture,
  story: ModuleStory,
  options: { calls?: boolean } = {},
): Architecture {
  const known = new Set(architecture.modules.map((module) => module.id))
  if (!known.has(story.anchor)) return architecture
  const ring = [...new Set(story.ring)].filter((id) => known.has(id) && id !== story.anchor)
  if (ring.length < 2) return architecture
  const links: ArchLink[] = []
  const linked = (from: string, to: string) =>
    links.some((link) => link.from === from && link.to === to)
  const add = (link: ArchLink) => {
    if (link.from !== link.to && !linked(link.from, link.to)) links.push(link)
  }
  // Lo que viaja: varios nombres entre los mismos dos módulos, en una sola flecha.
  const carried = new Map<string, { from: string; to: string; labels: string[] }>()
  for (const flow of story.flows) {
    if (!known.has(flow.from) || !known.has(flow.to) || flow.from === flow.to) continue
    const key = `${flow.from}|${flow.to}`
    const entry = carried.get(key) ?? { from: flow.from, to: flow.to, labels: [] }
    if (!entry.labels.includes(flow.label)) entry.labels.push(flow.label)
    carried.set(key, entry)
  }
  const first = ring[0] ?? ''
  const last = ring[ring.length - 1] ?? ''
  for (const { from, to, labels } of carried.values()) {
    const label = labels.slice(0, 2).join(', ')
    // Lo que un paso le deja a uno anterior es para la vuelta siguiente: se lo da la cabeza del ciclo, que es
    // quien decide si hay otra vuelta. Dibujado directo iría contra el sentido del anillo y por su centro; el
    // camino de vuelta ya lo cuenta el cierre del anillo, que lleva el dato si quien lo deja es el último.
    const back = ring.includes(from) && ring.includes(to) && ring.indexOf(to) < ring.indexOf(from)
    if (back) {
      if (from === last) add({ from, to: story.anchor, kind: 'data', label, told: true })
      add({ from: story.anchor, to, kind: 'data', label, told: true })
    } else add({ from, to, kind: 'data', label, told: true })
  }
  // El orden de la vuelta: cabeza → primer paso → … → último → cabeza, donde no viaje ya un dato.
  const lap = [story.anchor, ...ring, story.anchor]
  for (let at = 0; at + 1 < lap.length; at++) {
    add({ from: lap[at] ?? '', to: lap[at + 1] ?? '', kind: 'next', told: true })
  }
  // Lo de antes entra al primer paso (o a quien le pase algo).
  for (const id of story.before) {
    if (!known.has(id) || ring.includes(id) || id === story.anchor) continue
    if (!links.some((link) => link.from === id)) {
      add({ from: id, to: first, kind: 'next', told: true })
    }
  }
  // Del análisis se conserva lo que la ejecución no contradice: los datos que no pasan por una llamada (los
  // que guarda un módulo y leen otros) y, si se piden, las llamadas.
  for (const link of architecture.links) {
    if (link.kind === 'call' && options.calls !== true) continue
    if (link.kind === 'data' && (linked(link.from, link.to) || linked(link.to, link.from))) continue
    links.push(link)
  }
  return {
    modules: architecture.modules,
    links,
    shape: 'ciclo',
    anchor: story.anchor,
    order: ring,
    caption: story.caption,
  }
}

/** El último paso de la reproducción llega al nodo del resultado (que no es un módulo). */
export const RESULT_BEAT = 'prysel:result'

/**
 * Un paso de la **reproducción** de la historia: a qué módulo se llega y por qué flechas le llega algo en ese
 * momento (`desde>hasta`). `before`: lo que se hace una vez, antes; `lap`: la vuelta; `again`: se cierra la
 * vuelta y se repite; `result`: lo que sale al final.
 */
export interface Beat {
  at: string
  links: string[]
  phase: 'before' | 'lap' | 'again' | 'result'
}

/**
 * La historia, paso a paso, para verla pasar: lo de antes, una vuelta entera en su orden (cada paso con lo
 * que recibe), el cierre de la vuelta y, si lo hay, el resultado (`result`: los módulos que lo escriben).
 * Vacío si la arquitectura no está contada por su ejecución.
 */
export function beatsOf(
  architecture: Architecture,
  result: readonly string[] | null = null,
): Beat[] {
  const { anchor, order } = architecture
  if (anchor === undefined || order === undefined || order.length === 0) return []
  const told = architecture.links.filter((link) => link.told === true && link.kind !== 'call')
  const turning = new Set([anchor, ...order])
  const into = (id: string, from: (id: string) => boolean) =>
    told
      .filter((link) => link.to === id && from(link.from))
      .map((link) => `${link.from}>${link.to}`)
  const before = architecture.modules
    .map((module) => module.id)
    .filter((id) => !turning.has(id) && told.some((link) => link.from === id))
  const beats: Beat[] = before.map((id) => ({ at: id, links: [], phase: 'before' }))
  beats.push({ at: anchor, links: into(anchor, (id) => !turning.has(id)), phase: 'lap' })
  for (const id of order) beats.push({ at: id, links: into(id, () => true), phase: 'lap' })
  beats.push({ at: anchor, links: into(anchor, (id) => turning.has(id)), phase: 'again' })
  if (result && result.length > 0) {
    beats.push({
      at: RESULT_BEAT,
      links: result.map((id) => `${id}>${RESULT_BEAT}`),
      phase: 'result',
    })
  }
  return beats
}

const SAYS: [keyof ModuleFacts, string][] = [
  ['asks', 'pide datos por teclado'],
  ['prints', 'escribe en pantalla'],
  ['stores', 'solo guarda valores'],
  ['defines', 'solo define funciones'],
  ['loops', 'repite algo'],
  ['branches', 'elige entre varios caminos'],
]

/** Lo que el código de un módulo hace, dicho en una frase (para preguntarle a alguien por su papel). */
export function factsText(fact: ModuleFacts, pending: boolean): string {
  if (pending) return 'Aún no tiene código.'
  const said = SAYS.filter(([key]) => fact[key] === true).map(([, text]) => text)
  if (fact.calls > 0) said.push(`usa a ${fact.calls} de los otros módulos`)
  return said.length === 0
    ? 'Su código calcula o transforma algo.'
    : `Su código: ${said.join('; ')}.`
}
