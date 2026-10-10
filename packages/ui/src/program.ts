import { gistPeek } from './gist.ts'
import { useCallback, useMemo, useState } from 'react'
import {
  getKind,
  valueTypeOf,
  type ControlModel,
  type Density,
  type NodeAction,
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
import { isTerritory } from './flow/frame.ts'

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
  /** Su última línea, si abarca varias. */
  lineEnd?: number
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
  /** Los nombres de una asignación de varios valores: cada uno sale por su puerto. */
  results?: string[]
  /** Los parámetros de una función: cada uno es un puerto de salida hacia su interior. */
  params?: string[]
  /** Qué campos aceptan un cable. Aquí solo importa cuáles. */
  inputs?: Record<string, unknown>
  /** Los nombres que el nodo puede leer: lo definido antes, en su ámbito. */
  scope?: string[]
  /** Dónde está en el archivo: aquí solo importa qué sentencia lo posee (la función, el bucle o la decisión que lo envuelve). */
  range?: { owner?: string }
  calls?: string
  /** Las funciones, clases y métodos del archivo a los que llama (sus subprocesos), en orden. */
  callees?: string[]
  note?: string
  /** En una decisión: el `elif` en el que sigue su camino falso. */
  continues?: string
}

/**
 * Una etapa tal como la da el analizador: un tramo de sentencias de un bloque que abre un comentario de
 * sección (`# Probar: cada pájaro vuela`). No es una sentencia: agrupa las que ya son nodos.
 */
export interface SourceSection {
  id: string
  title: string
  subtitle?: string
  note?: string
  /** La sentencia dueña del bloque; sin ella, es del programa. */
  owner?: string
  /** Las sentencias directas del bloque que abarca, en orden. */
  members: readonly string[]
  line: number
  lineEnd: number
}

/** Lo que esconde una etapa plegada: un bucle, una decisión o algo que se imprime o se enseña. */
export type SectionGlyph = 'loop' | 'branch' | 'output'

/** Un subproceso: una función, una clase o un método del archivo al que llama un nodo. */
export interface Subprocess {
  id: string
  /** Como se lee: `volar`, `Pajaro`, `Pajaro.decidir`. */
  name: string
}

/** Lo que el lienzo sabe de una etapa: su número, su título y lo que dice de ella plegada. */
export interface SectionInfo {
  /** El id de la etapa (en un bucle que la encabeza, el de la etapa, no el del bucle). */
  id: string
  /** Su número en el esquema: `2`, `2.3`. */
  ordinal: string
  title: string
  subtitle?: string
  /** Lo que lee de antes de ella (sin las constantes del programa). */
  uses: readonly string[]
  /**
   * Lo que deja para después, qué nodo lo define y, si se ha ejecutado, lo que valía (lo que ese nodo
   * observó): así la tarjeta plegada enseña el resultado de la fase sin abrirla.
   */
  leaves: readonly {
    name: string
    from: string
    value?: { short?: string; long: string; changed?: boolean }
  }[]
  /** Sus sentencias directas, en orden: lo que se pone «detrás de la etapa» va tras la última. */
  members: readonly string[]
  /** Los subprocesos a los que llama lo que tiene dentro. */
  opens: readonly Subprocess[]
  glyphs: readonly SectionGlyph[]
  /** Cuántas sentencias agrupa, contando lo de dentro. */
  size: number
  /** La etapa es un solo territorio (un bucle): no se dibuja aparte, lo encabeza. */
  merged?: boolean
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
  const byId = new Map(nodes.map((node) => [node.id, node]))
  /** Cómo se lee un subproceso: un método lleva delante su clase (`Pajaro.decidir`). */
  const subprocess = (id: string): Subprocess | null => {
    const target = byId.get(id)
    if (!target) return null
    const owner = target.range?.owner === undefined ? undefined : byId.get(target.range.owner)
    return {
      id,
      name: owner?.kind === 'abstraction.class' ? `${owner.label}.${target.label}` : target.label,
    }
  }
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
    ...(node.lineEnd === undefined ? {} : { lineEnd: node.lineEnd }),
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
    ...(node.results && node.results.length > 0 ? { results: node.results } : {}),
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
    ...(node.continues ? { continues: node.continues } : {}),
    // Una llamada a una función del archivo lleva a ella.
    ...(node.calls ? { opens: node.calls, openable: true } : {}),
    // Y todas las que hace (también dentro de una comprensión o por un objeto) son subprocesos que se abren.
    ...(node.callees && node.callees.length > 0
      ? {
          subprocesses: node.callees.flatMap((id) => {
            const found = id === node.id ? null : subprocess(id)
            return found ? [found] : []
          }),
        }
      : {}),
  }))
}

/** Un nombre de constante (`TAMANO_POBLACION`): un ajuste del programa, no un dato de una etapa. */
const CONSTANT = /^[\p{Lu}_][\p{Lu}\p{N}_]*$/u

/** El nombre del valor que viaja por una conexión de datos: lo que define su origen, o su parámetro. */
function valueName(edge: SemanticEdge, byId: ReadonlyMap<string, CanvasNode>): string | undefined {
  const port = edge.fromPort
  if (port?.startsWith('param:')) return port.slice('param:'.length)
  if (port?.startsWith('result:')) return port.slice('result:'.length)
  return byId.get(edge.from)?.provides
}

/**
 * Las **etapas** en el lienzo. Cada una pasa a ser un territorio (`space.section`) que envuelve sus
 * sentencias y lo que hay dentro de ellas, con su número en el esquema (`2.3`) y lo que dice de sí misma
 * plegada: lo que usa de antes, lo que deja para después, a qué subprocesos llama y qué esconde.
 *
 * - El `owner` de cada nodo **no cambia** (sigue siendo su bloque de verdad: las cajitas de chips y las
 *   ramas del diagrama de flujo dependen de él). El marco sale de `contains`, y la etapa se añade al
 *   `contains` de lo que la envuelve para que la gramática la coloque dentro.
 * - Una etapa cuyo único miembro es un territorio (un bucle) no dibuja un marco dentro de otro: su título
 *   encabeza ese territorio (`merged`).
 */
export function withSections(
  nodes: CanvasNode[],
  edges: readonly SemanticEdge[],
  sections: readonly SourceSection[],
): CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const valid = [...sections]
    .filter((s) => s.members.length > 0 && s.members.every((id) => byId.has(id)))
    .sort((a, b) => a.line - b.line)
  if (valid.length === 0) return nodes

  // Lo que cuelga de cada sentencia: lo que declara que contiene (un bucle, una función) y lo que la tiene
  // por dueña (los caminos de una decisión, que no declaran `contains`).
  const owned = new Map<string, string[]>()
  for (const node of nodes) {
    if (node.owner !== undefined) owned.set(node.owner, [...(owned.get(node.owner) ?? []), node.id])
  }
  const deepOf = (ids: readonly string[]): Set<string> => {
    const found = new Set<string>()
    const walk = (id: string) => {
      if (found.has(id)) return
      found.add(id)
      for (const child of byId.get(id)?.contains ?? []) walk(child)
      for (const child of owned.get(id) ?? []) walk(child)
    }
    for (const id of ids) walk(id)
    return found
  }
  const inside = new Map(valid.map((s) => [s.id, deepOf(s.members)]))

  // El número de cada una: su puesto entre las de su bloque, detrás del de la etapa que envuelve el bloque.
  const ordinal = new Map<string, string>()
  const count = new Map<string, number>()
  for (const s of valid) {
    const block = s.owner ?? ''
    const index = (count.get(block) ?? 0) + 1
    count.set(block, index)
    const parent =
      s.owner === undefined
        ? undefined
        : valid
            .filter((other) => other !== s && inside.get(other.id)?.has(s.owner ?? ''))
            .sort((a, b) => (inside.get(a.id)?.size ?? 0) - (inside.get(b.id)?.size ?? 0))[0]
    const prefix = parent ? ordinal.get(parent.id) : undefined
    ordinal.set(s.id, prefix ? `${prefix}.${index}` : String(index))
  }

  const dataEdges = edges.filter((edge) => channelOf(edge) === 'data')
  const infoOf = (s: SourceSection, merged: boolean): SectionInfo => {
    const own = inside.get(s.id) ?? new Set<string>()
    // Ni los ajustes del programa (constantes), ni las funciones (van en las pastillas), ni los módulos.
    const skip = (edge: SemanticEdge, name: string | undefined): name is undefined => {
      const kind = byId.get(edge.from)?.kind ?? 'opaque.code'
      return (
        name === undefined ||
        CONSTANT.test(name) ||
        kind === 'external.import' ||
        // Un parámetro sí es un dato (`genoma`): lo que no cuenta es el nombre de la función.
        (getKind(kind).role === 'abstraction' && !edge.fromPort?.startsWith('param:'))
      )
    }
    const uses: string[] = []
    const leaves: { name: string; from: string }[] = []
    for (const edge of dataEdges) {
      const name = valueName(edge, byId)
      if (skip(edge, name)) continue
      if (own.has(edge.to) && !own.has(edge.from) && !uses.includes(name)) uses.push(name)
      if (own.has(edge.from) && !own.has(edge.to) && !leaves.some((leaf) => leaf.name === name)) {
        leaves.push({ name, from: edge.from })
      }
    }
    // Lo que se reasigna para la vuelta siguiente (`poblacion = nueva`) no lo lee nadie después en el
    // texto: si no deja otra cosa, deja lo que definen sus sentencias.
    if (leaves.length === 0) {
      for (const id of s.members) {
        const node = byId.get(id)
        for (const name of node?.results ?? (node?.provides ? [node.provides] : [])) {
          if (!CONSTANT.test(name)) leaves.push({ name, from: id })
        }
      }
    }
    const opens: Subprocess[] = []
    const glyphs = new Set<SectionGlyph>()
    for (const id of own) {
      const node = byId.get(id)
      if (!node) continue
      for (const sub of node.subprocesses ?? []) {
        if (!opens.some((o) => o.id === sub.id)) opens.push(sub)
      }
      if (node.kind === 'control.loop') glyphs.add('loop')
      if (node.kind === 'control.condition') glyphs.add('branch')
      if (node.kind === 'effect.io' || node.kind === 'output.display') glyphs.add('output')
    }
    return {
      id: s.id,
      ordinal: ordinal.get(s.id) ?? '',
      title: s.title,
      ...(s.subtitle ? { subtitle: s.subtitle } : {}),
      uses,
      leaves: leaves.map((leaf) => {
        const value = byId.get(leaf.from)?.observed?.[leaf.name]
        return value ? { ...leaf, value } : leaf
      }),
      members: s.members,
      opens,
      glyphs: (['loop', 'branch', 'output'] as const).filter((g) => glyphs.has(g)),
      size: own.size,
      ...(merged ? { merged: true } : {}),
    }
  }

  const patched = new Map<string, CanvasNode>()
  const created = new Map<string, CanvasNode[]>()
  for (const s of valid) {
    const only = s.members.length === 1 ? byId.get(s.members[0] ?? '') : undefined
    if (only && isTerritory(only)) {
      // Un bucle que es toda la etapa: lleva su título y su número en su propia cabecera.
      const base = patched.get(only.id) ?? only
      const note = [s.subtitle, s.note, base.note].filter(Boolean).join('\n\n')
      patched.set(only.id, {
        ...base,
        label: s.title,
        renamable: true,
        section: infoOf(s, true),
        ...(note ? { note } : {}),
      })
      continue
    }
    const first = s.members[0] ?? ''
    const node: CanvasNode = {
      id: s.id,
      kind: 'space.section',
      label: s.title,
      line: s.line,
      meta: s.lineEnd > s.line ? `líneas ${s.line}–${s.lineEnd}` : `línea ${s.line}`,
      contains: [...(inside.get(s.id) ?? [])],
      ...(s.owner === undefined ? {} : { owner: s.owner }),
      ...(s.note ? { note: s.note } : {}),
      renamable: true,
      section: infoOf(s, false),
    }
    created.set(first, [...(created.get(first) ?? []), node])
  }

  // Lo que envuelve a una etapa (su bloque, lo de fuera, otra etapa) la lleva en su `contains`.
  const all = [
    ...nodes.map((node) => patched.get(node.id) ?? node),
    ...[...created.values()].flat(),
  ]
  const containsOf = new Map(all.map((node) => [node.id, node.contains]))
  for (const group of created.values()) {
    for (const node of group) {
      const first = node.contains?.[0]
      if (first === undefined) continue
      for (const other of all) {
        if (other.id === node.id) continue
        const list = containsOf.get(other.id)
        if (list?.includes(first) && !list.includes(node.id)) {
          containsOf.set(other.id, [...list, node.id])
        }
      }
    }
  }
  const settle = (node: CanvasNode): CanvasNode => {
    const contains = containsOf.get(node.id)
    return contains === node.contains || contains === undefined ? node : { ...node, contains }
  }

  // En el orden del programa: cada etapa justo antes de su primera sentencia (y la de fuera, antes).
  return nodes.flatMap((node) => [
    ...(created.get(node.id) ?? []).map(settle),
    settle(patched.get(node.id) ?? node),
  ])
}

/** ¿Es una etapa dibujada aparte (no una que encabeza un bucle)? */
export const isSection = (node: Pick<CanvasNode, 'kind'>): boolean => node.kind === 'space.section'

/**
 * Una etapa no es una sentencia: lo que el lienzo pide «detrás de», «dentro de» o «antes de» una etapa se
 * traduce a su bloque real (tras su última sentencia, antes de la primera). Lo que se le haría a una
 * sentencia (borrarla, duplicarla, moverla, reescribirla) no se le hace a una etapa: `null`.
 */
export function resolveSectionAction(
  action: NodeAction,
  sectionOf: (id: string) => SectionInfo | undefined,
): NodeAction | null {
  const find = (id: string | undefined) => (id === undefined ? undefined : sectionOf(id))
  const first = (s: SectionInfo) => s.members[0] ?? ''
  const last = (s: SectionInfo) => s.members[s.members.length - 1] ?? ''
  switch (action.type) {
    case 'add': {
      const target = find(action.into) ?? find(action.after)
      if (!target) return action
      return {
        type: 'add',
        template: action.template,
        after: last(target),
        ...(action.connect ? { connect: action.connect } : {}),
      }
    }
    case 'move': {
      if (find(action.id)) return null
      const into = find(action.into)
      const after = find(action.after)
      const before = find(action.before)
      if (into) {
        return action.start
          ? { type: 'move', id: action.id, before: first(into) }
          : { type: 'move', id: action.id, after: last(into) }
      }
      if (after) return { type: 'move', id: action.id, after: last(after) }
      if (before) return { type: 'move', id: action.id, before: first(before) }
      return action
    }
    case 'code':
    case 'delete':
    case 'duplicate':
    case 'rename':
    case 'callee':
      return find(action.id) ? null : action
    default:
      return action
  }
}

/** Una función con cuerpo: es la que aparece en el menú «Funciones» y la que se ve aparte. */
function isFunction(node: CanvasNode): boolean {
  return getKind(node.kind).role === 'abstraction' && (node.contains?.length ?? 0) > 0
}

/**
 * Los `if` que tienen tarjeta «Cómo funciona», con lo que abarcan: los nodos cuya línea cae dentro (sus ramas y
 * sus `elif`). En el modelo un `if` no contiene sus ramas (son nodos sueltos unidos por aristas); para plegarlo
 * en su tarjeta, la vista las agrupa.
 */
export function branchScopes(nodes: readonly CanvasNode[]): Map<string, string[]> {
  const scopes = new Map<string, string[]>()
  for (const node of nodes) {
    if (node.kind !== 'control.condition' || !node.gist || node.lineEnd === undefined) continue
    const from = node.line
    const to = node.lineEnd
    if (from === undefined) continue
    const members = nodes
      .filter((other) => other.id !== node.id && other.line !== undefined)
      .filter((other) => (other.line as number) > from && (other.line as number) <= to)
      .map((other) => other.id)
    if (members.length > 0) scopes.set(node.id, members)
  }
  return scopes
}

/** Un ámbito plegable: una función con cuerpo o un bucle con cuerpo (no una decisión). */
function isFoldable(node: CanvasNode): boolean {
  return isFunction(node) || isTerritory(node)
}

export interface FunctionInfo {
  id: string
  name: string
  /** `(a, b)`: lo que la función recibe. */
  signature: string
  /** Los nombres de sus parámetros, en orden. */
  params: string[]
  /** Su línea en el archivo. */
  line?: number
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
  /**
   * La función dentro de la que está definida (la más cercana hacia fuera), si no es del programa: una
   * función anidada solo existe ahí dentro.
   */
  scope?: string
}

/** La función más cercana que envuelve a un nodo (atravesando bucles y decisiones), si la hay. */
function enclosingFunctionOf(
  node: CanvasNode,
  byId: ReadonlyMap<string, CanvasNode>,
): string | undefined {
  let up = node.owner
  for (let guard = 0; up !== undefined && guard < 64; guard++) {
    const owner = byId.get(up)
    if (!owner) return undefined
    if (owner.kind === 'abstraction.collapsed') return owner.id
    up = owner.owner
  }
  return undefined
}

export function functionsOf(nodes: CanvasNode[], edges: SemanticEdge[]): FunctionInfo[] {
  // Un método vive dentro de su clase: no es una función que se llame suelta, ni se ofrece como chip.
  const classes = new Set(nodes.filter((n) => n.kind === 'abstraction.class').map((n) => n.id))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return nodes
    .filter((node) => isFunction(node) && !classes.has(node.owner ?? ''))
    .map((node) => {
      const scope = enclosingFunctionOf(node, byId)
      const body = new Set(node.contains)
      // Una función recibe sus parámetros; una clase, los de su `__init__` al crearse.
      const names =
        node.control?.kind === 'signature'
          ? node.control.params.map((p) => p.name)
          : node.control?.kind === 'class'
            ? node.control.params
            : []
      return {
        id: node.id,
        name: node.label,
        signature: `(${names.join(', ')})`,
        params: names,
        ...(node.line === undefined ? {} : { line: node.line }),
        calls: callsTo(nodes, node.id),
        used: edges.some((edge) => edge.from === node.id && !body.has(edge.to)),
        size: body.size,
        ...(node.note ? { doc: node.note } : {}),
        ...(scope === undefined ? {} : { scope }),
      }
    })
}

/** Cuántos nodos llaman a una definición: como sentencia (`opens`) o metida en una expresión (`subprocesses`). */
const callsTo = (nodes: readonly CanvasNode[], id: string) =>
  nodes.filter((other) => other.opens === id || other.subprocesses?.some((s) => s.id === id)).length

/**
 * Los métodos de las clases del archivo. No se ofrecen como chips (se llaman por un objeto), pero se pueden
 * abrir como una función: desde la pastilla de una llamada (`pajaro.decidir`) o desde el menú.
 */
export function methodsOf(nodes: CanvasNode[]): FunctionInfo[] {
  const classes = new Map(
    nodes.filter((n) => n.kind === 'abstraction.class').map((n) => [n.id, n] as const),
  )
  return nodes
    .filter((node) => isFunction(node) && classes.has(node.owner ?? ''))
    .map((node) => {
      const owner = classes.get(node.owner ?? '')
      const names =
        node.control?.kind === 'signature'
          ? node.control.params
              .map((p) => p.name)
              .filter((name) => name !== 'self' && name !== 'cls')
          : []
      return {
        id: node.id,
        name: `${owner?.label ?? ''}.${node.label}`,
        signature: `(${names.join(', ')})`,
        params: names,
        ...(node.line === undefined ? {} : { line: node.line }),
        calls: callsTo(nodes, node.id),
        used: true,
        size: node.contains?.length ?? 0,
        ...(node.note ? { doc: node.note } : {}),
        ...(owner ? { scope: owner.id } : {}),
      }
    })
}

export interface FoldedView {
  nodes: CanvasNode[]
  edges: SemanticEdge[]
}

/** A partir de cuántas etapas con tarjeta dentro el programa se enseña como un mapa (todas en su rótulo). */
export const MAP_FROM = 3

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
  // Lo que envuelve a lo enfocado (la clase de un método) no se esconde: se estaría escondiendo lo que se mira.
  const around = new Set(
    focus === null
      ? []
      : nodes.filter((node) => node.contains?.includes(focus)).map((node) => node.id),
  )
  // Una función de la que se sabe qué hace no se esconde aunque el programa la use: su tarjeta es lo que se
  // lee de ella.
  const gisted = new Set(nodes.filter((node) => node.gist).map((node) => node.id))
  const used = functionsOf(nodes, edges).filter(
    (f) => f.used && f.id !== focus && !around.has(f.id) && !gisted.has(f.id),
  )
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
 * **El programa desplegado.** Un script suele ser un puñado de constantes y una llamada (`entrenar()`), y
 * el algoritmo está dentro de la función. Si el programa la llama una sola vez, desde su punto de entrada
 * (o desde el propio archivo), se dibuja **su territorio en el sitio de la llamada**: así lo primero que se ve
 * es el algoritmo. La función sigue apareciendo una sola vez (ahí), y se puede abrir aparte como siempre.
 *
 * Solo una llamada que es toda la sentencia (`entrenar()`): una que guarda su resultado (`x = f()`) perdería
 * la asignación.
 */
export function inlineCalls(
  nodes: readonly CanvasNode[],
  edges: readonly SemanticEdge[],
  shown: FoldedView,
  functions: readonly FunctionInfo[],
): FoldedView & { inlined: ReadonlySet<string> } {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const visible = new Set(shown.nodes.map((node) => node.id))
  const entries = shown.nodes.filter((node) => node.kind === 'control.entrypoint')
  const calls = shown.nodes.filter((node) => {
    if (node.opens === undefined || node.provides !== undefined || node.results) return false
    const fn = functions.find((f) => f.id === node.opens)
    if (!fn || fn.calls !== 1 || visible.has(fn.id)) return false
    return entries.length > 0
      ? entries.some((entry) => entry.id === node.owner)
      : node.owner === undefined
  })
  if (calls.length === 0) return { ...shown, inlined: NONE }

  const swap = new Map<string, string>()
  const owners = new Map<string, string | undefined>()
  const extra = new Map<string, string[]>()
  for (const call of calls) {
    const fn = byId.get(call.opens ?? '')
    if (!fn) continue
    swap.set(call.id, fn.id)
    owners.set(fn.id, call.owner)
    const body = [fn.id, ...(fn.contains ?? [])]
    for (const id of body) visible.add(id)
    visible.delete(call.id)
    // Lo que envolvía a la llamada (el punto de entrada) envuelve ahora a la función y su cuerpo.
    for (const node of shown.nodes) {
      if (node.contains?.includes(call.id))
        extra.set(node.id, [...(extra.get(node.id) ?? []), ...body])
    }
  }
  const inlined = new Set(swap.values())
  const seen = new Set<string>()
  return {
    nodes: nodes.flatMap((node) => {
      if (!visible.has(node.id)) return []
      const more = extra.get(node.id)
      const owned = owners.has(node.id)
      if (!more && !owned) return [node]
      const copy: CanvasNode = { ...node }
      if (owned) {
        // La función pasa a ser de quien era la llamada (el punto de entrada, o el programa).
        const owner = owners.get(node.id)
        if (owner === undefined) delete copy.owner
        else copy.owner = owner
      }
      if (more) copy.contains = [...(node.contains ?? []), ...more]
      return [copy]
    }),
    edges: edges.flatMap((edge) => {
      const from = swap.get(edge.from) ?? edge.from
      const to = swap.get(edge.to) ?? edge.to
      if (from === to || !visible.has(from) || !visible.has(to)) return []
      const key = `${from}|${to}|${edge.relation}|${edge.fromPort ?? ''}|${edge.toPort ?? ''}|${edge.label ?? ''}`
      if (seen.has(key)) return []
      seen.add(key)
      return [from === edge.from && to === edge.to ? edge : { ...edge, from, to }]
    }),
    inlined,
  }
}

/**
 * En una etapa abierta, la secuencia entra por su marco (como en un `with`), no por encima de su título
 * hasta su primera sentencia: lo que llega a su primera sentencia desde fuera llega a la etapa. Lo que sale
 * sale de donde sale de verdad (el final de un camino, el «no» de una decisión). Una etapa plegada ya lo
 * tiene resuelto: el colapso lleva al borde todo lo que lo cruza.
 */
export function enterSections(view: FoldedView, folded: ReadonlySet<string>): FoldedView {
  const open = view.nodes.filter((node) => isSection(node) && !folded.has(node.id))
  if (open.length === 0) return view
  const entry = new Map<string, { id: string; inside: ReadonlySet<string> }[]>()
  for (const section of open) {
    const first = section.contains?.[0]
    if (first === undefined) continue
    entry.set(first, [
      ...(entry.get(first) ?? []),
      { id: section.id, inside: new Set(section.contains) },
    ])
  }
  let changed = false
  const seen = new Set<string>()
  const edges = view.edges.flatMap((edge) => {
    let to = edge.to
    // La secuencia, las ramas y la entrada de un territorio (un bucle, un `with`) a su primera sentencia.
    const entering =
      edge.relation === 'sequence' ||
      edge.relation === 'branch' ||
      (edge.relation === 'transform' && channelOf(edge) === 'control')
    if (entering) {
      // La de más fuera que empiece aquí y no contenga el origen.
      const around = (entry.get(to) ?? []).filter((s) => !s.inside.has(edge.from))
      const outer = around.sort((a, b) => b.inside.size - a.inside.size)[0]
      if (outer) to = outer.id
    }
    if (to === edge.to) return [edge]
    changed = true
    const key = `${edge.from}|${to}|${edge.relation}|${edge.label ?? ''}`
    if (seen.has(key)) return []
    seen.add(key)
    // Llega a la etapa, no a un campo de su primera sentencia.
    const next: SemanticEdge = { ...edge, to }
    delete next.toPort
    return [next]
  })
  return changed ? { nodes: view.nodes, edges } : view
}

/**
 * Las etapas **hoja**: las que no tienen otra etapa dentro (también un bucle que encabeza una). Son las que
 * normal enseña plegadas: el esquema se ve entero y cada fase se abre donde está.
 */
export function leafSections(nodes: readonly CanvasNode[]): ReadonlySet<string> {
  const sections = nodes.filter((node) => node.section !== undefined)
  return new Set(
    sections
      .filter(
        (node) => !sections.some((other) => other !== node && node.contains?.includes(other.id)),
      )
      .map((node) => node.id),
  )
}

/**
 * Lo que representa en el lienzo a un nodo que no se ve: el contenedor visible más pequeño que lo tiene
 * dentro (la etapa plegada, la función plegada). El propio nodo si se ve; `null` si nada lo representa.
 */
export function representativeIn(nodes: readonly CanvasNode[], id: string): string | null {
  let best: CanvasNode | null = null
  for (const node of nodes) {
    if (node.id === id) return id
    if (!node.contains?.includes(id)) continue
    if (!best || (node.contains.length ?? 0) < (best.contains?.length ?? 0)) best = node
  }
  return best?.id ?? null
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
export function foldReturns(
  nodes: CanvasNode[],
  edges: SemanticEdge[],
  /**
   * Leído como diagrama de flujo, ningún `return` se esconde: es el último paso de su camino, y sin él la
   * secuencia no acabaría en ninguna parte.
   */
  options: { hide?: boolean } = {},
): FoldedView {
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
          // Solo el `return` del cuerpo de la función: uno dentro de una rama o de un bucle es un paso de la
          // secuencia (ahí termina ese camino) y se queda a la vista.
          if (node.owner !== undefined && node.owner !== def.id) return false
          if (!IDENTIFIER.test(control.args[0]?.value.trim() ?? '')) return false
          // El orden no cuenta: un retorno alcanzado solo por la sentencia anterior sigue siendo simple.
          const incoming = edges.filter(
            (edge) => edge.to === node.id && edge.relation !== 'sequence',
          )
          return (
            incoming.length > 0 &&
            incoming.every((edge) => edge.toPort === 'arg:valor' && channelOf(edge) === 'data')
          )
        })
        .map((node) => node.id),
    )
    // Sin nada más dentro, no habría territorio: se quedan a la vista.
    if (body.every((id) => simple.has(id)) || options.hide === false) simple.clear()

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
        // El orden se queda como está: lo que se oculta se salta al colocarlo (`contractOrder`).
        if (edge.relation === 'sequence') return [edge]
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
  /** Los métodos de sus clases: se pueden abrir, aunque no se ofrezcan como chips. */
  methods: FunctionInfo[]
  /** La función (o el método) que se está viendo, o `null` si es el programa. */
  focus: FunctionInfo | null
  /** Las funciones por las que se llegó a la que se ve, desde el programa (las migas). */
  trail: FunctionInfo[]
  /** Ir a una función (o volver al programa con `null`): empieza un camino nuevo. */
  open: (id: string | null) => void
  /** Abrir un subproceso desde lo que se ve: el camino sigue (Programa › volar › Pajaro.decidir). */
  descend: (id: string) => void
  /** Lo que hace el chevron de un nodo: una llamada abre su función; una función, un bucle o una etapa se pliega o se abre. */
  enter: (id: string) => void
  /**
   * Abre lo que envuelve a estos nodos si está plegado de serie (una etapa, sobre todo): es lo que hace un
   * momento de la lección con la sentencia de la que habla. Lo que abrió la llamada anterior se vuelve a
   * cerrar; lo que el usuario abrió o cerró a mano, no se toca.
   */
  reveal: (ids: readonly string[]) => void
  /** El nodo que se ve en lugar de uno que no se ve (la etapa plegada que lo tiene dentro), o `null`. */
  representative: (id: string) => string | null
  /** Qué vista enseña el cuerpo de una función: la del programa (`null`) si está desplegada ahí. */
  homeOf: (id: string) => string | null
  /** Cuántos ámbitos hay plegados ahora. */
  folded: number
  /** Cambia con lo que se ve: es la señal para que el lienzo se reencuadre. */
  viewKey: string
}

const NO_SECTIONS: readonly SourceSection[] = []

/**
 * Lo que se ve, de una vez y sin estado (el hook solo guarda lo que el usuario plegó o abrió): el programa o la
 * función enfocada, con la principal desplegada en el programa; lo plegado según la densidad (compacto, todo;
 * normal, las etapas hoja; expandido, nada) y lo que el usuario o un momento de la lección dieron la vuelta.
 */
export function viewOf(
  all: CanvasNode[],
  edges: SemanticEdge[],
  functions: readonly FunctionInfo[],
  options: {
    focus: string | null
    flow: boolean
    density: Density
    /** Lo que el usuario dio la vuelta (abrió o plegó a mano). */
    flipped?: ReadonlySet<string>
    /** Lo que se abrió para enseñar algo (un momento de la lección). */
    revealed?: ReadonlySet<string>
  },
): {
  base: FoldedView
  folded: ReadonlySet<string>
  view: FoldedView
  byDefault: (id: string) => boolean
} {
  const { focus, flow, density } = options
  const shown = programView(all, edges, focus)
  const base = focus === null && flow ? inlineCalls(all, edges, shown, functions) : shown
  // Un `if` con tarjeta se pliega como un ámbito más: sus ramas se agrupan solo aquí, en la vista.
  const branched = branchScopes(base.nodes)
  // La función que se está viendo nunca se pliega: sería quedarse sin ver lo que se pidió ver.
  const scopes = base.nodes.filter(
    (node) => (isFoldable(node) || branched.has(node.id)) && node.id !== focus,
  )
  const leaves = leafSections(base.nodes)
  // En normal, una función de la que se sabe qué hace empieza plegada en su tarjeta: se abre para ver cómo.
  const gisted = new Set(base.nodes.filter((node) => node.gist).map((node) => node.id))
  // Una etapa que guarda dentro algo con tarjeta (una función de la que se sabe qué hace, un bucle del que se
  // sabe cómo funciona) empieza abierta: plegada, su rótulo taparía justo lo que mejor la explica. Dentro,
  // cada cosa con tarjeta sigue plegada en la suya.
  const holding = new Set(
    base.nodes
      .filter((node) => isSection(node) && node.contains?.some((id) => gisted.has(id)))
      .map((node) => node.id),
  )
  // …pero con muchas así el programa no cabe en una pantalla: entonces se lee como un mapa (cada parte en
  // su rótulo, con lo que hace en una línea) y se abre la que interese.
  const map = holding.size > MAP_FROM
  const byDefault = (id: string) =>
    density === 'compact'
      ? true
      : density === 'normal'
        ? (leaves.has(id) && (map || !holding.has(id))) || gisted.has(id)
        : false
  const folded = new Set(
    scopes
      .map((node) => node.id)
      .filter(
        (id) =>
          (byDefault(id) && !(options.revealed?.has(id) ?? false)) !==
          (options.flipped?.has(id) ?? false),
      ),
  )
  // Plegado, el `if` recoge sus ramas (y se ve su tarjeta); abierto, es el rombo de siempre, con su chevron
  // para volver a plegarlo.
  const scenes = new Map(base.nodes.flatMap((node) => (node.gist ? [[node.id, node.gist]] : [])))
  const prepared =
    branched.size === 0 && holding.size === 0
      ? base.nodes
      : base.nodes.map((node) => {
          // Una etapa plegada que guarda algo con tarjeta dice, en su rótulo, lo que eso hace.
          if (node.section && holding.has(node.id) && folded.has(node.id)) {
            const inner = node.contains?.map((id) => scenes.get(id)).find((scene) => scene)
            const peek = inner ? gistPeek(inner) : ''
            return peek === ''
              ? node
              : {
                  ...node,
                  section: { ...node.section, subtitle: peek },
                  note: [node.section.subtitle, node.note].filter(Boolean).join('\n\n'),
                }
          }
          const members = branched.get(node.id)
          if (!members) return node
          if (folded.has(node.id)) return { ...node, contains: members, openable: true }
          const open = { ...node, openable: true }
          delete open.gist
          return open
        })
  const collapsed = foldScopes(prepared, base.edges, folded)
  const returns = foldReturns(collapsed.nodes, collapsed.edges, { hide: !flow })
  return { base, folded, view: flow ? enterSections(returns, folded) : returns, byDefault }
}

/**
 * Qué se ve y cómo. Cada densidad es una decisión de «cuánto quiero ver»:
 * - **Compacto** pliega todo (funciones, bucles, etapas): la vista de pájaro, que el programa quepa en una mirada.
 * - **Normal** pliega las **etapas hoja**: se ve el esquema del algoritmo, y cada fase se abre donde está.
 * - **Expandido** lo abre todo.
 *
 * El usuario puede darle la vuelta a cualquiera; cambiar de densidad vuelve a lo de serie.
 */
export function useProgramView(
  nodes: CanvasNode[],
  edges: SemanticEdge[],
  density: Density,
  options: {
    /** Se dibuja como diagrama de flujo (leído hacia abajo): los `return` se quedan como pasos. */
    flow?: boolean
    /** Las etapas del programa (solo en el diagrama de flujo). */
    sections?: readonly SourceSection[]
  } = {},
): ProgramView {
  const flow = options.flow === true
  const sections = flow ? (options.sections ?? NO_SECTIONS) : NO_SECTIONS
  const mode = density
  const [focusId, setFocusId] = useState<string | null>(null)
  const [trailIds, setTrailIds] = useState<readonly string[]>([])
  const [state, setState] = useState<{ mode: string; flipped: ReadonlySet<string> }>({
    mode,
    flipped: NONE,
  })
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(NONE)
  const flipped = state.mode === mode ? state.flipped : NONE

  const all = useMemo(() => withSections(nodes, edges, sections), [nodes, edges, sections])
  const functions = useMemo(() => functionsOf(all, edges), [all, edges])
  const methods = useMemo(() => methodsOf(all), [all])
  // Si la función enfocada desaparece (se borró del código), se vuelve al programa.
  const focus = useMemo(
    () =>
      functions.find((fn) => fn.id === focusId) ?? methods.find((fn) => fn.id === focusId) ?? null,
    [functions, methods, focusId],
  )
  const trail = useMemo(
    () =>
      trailIds.flatMap((id) => {
        const fn = functions.find((f) => f.id === id) ?? methods.find((f) => f.id === id)
        return fn ? [fn] : []
      }),
    [trailIds, functions, methods],
  )

  /** Lo que el programa despliega en su sitio (su función principal): se calcula aunque se vea otra cosa. */
  const programInlined = useMemo(
    () => (flow ? inlineCalls(all, edges, programView(all, edges, null), functions).inlined : NONE),
    [flow, all, edges, functions],
  )
  const {
    base,
    folded: foldedSet,
    view,
    byDefault,
  } = useMemo(
    () =>
      viewOf(all, edges, functions, {
        focus: focus?.id ?? null,
        flow,
        density: mode,
        flipped,
        revealed,
      }),
    [all, edges, functions, focus, flow, mode, flipped, revealed],
  )

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

  const open = useCallback((id: string | null) => {
    setTrailIds([])
    setFocusId(id)
  }, [])
  const descend = useCallback(
    (id: string) => {
      if (id === focusId) return
      setTrailIds((previous) => {
        // Volver a una función del camino es recortarlo hasta ella.
        const at = previous.indexOf(id)
        if (at >= 0) return previous.slice(0, at)
        return focusId === null ? [] : [...previous, focusId]
      })
      setFocusId(id)
    },
    [focusId],
  )

  const enter = useCallback(
    (id: string) => {
      const target = all.find((node) => node.id === id)
      if (target?.opens && !target.contains?.length) descend(target.opens)
      else toggle(id)
    },
    [all, descend, toggle],
  )

  const reveal = useCallback(
    (ids: readonly string[]) => {
      const opened = new Set<string>()
      for (const node of base.nodes) {
        if (!byDefault(node.id) || !isFoldable(node)) continue
        if (ids.some((id) => node.contains?.includes(id))) opened.add(node.id)
      }
      setRevealed((previous) =>
        previous.size === opened.size && [...opened].every((id) => previous.has(id))
          ? previous
          : opened,
      )
    },
    [base, byDefault],
  )
  const representative = useCallback((id: string) => representativeIn(view.nodes, id), [view])
  const homeOf = useCallback((id: string) => (programInlined.has(id) ? null : id), [programInlined])

  return {
    ...view,
    functions,
    methods,
    focus,
    trail,
    open,
    descend,
    enter,
    reveal,
    representative,
    homeOf,
    folded: foldedSet.size,
    viewKey: focus?.id ?? PROGRAM,
  }
}
