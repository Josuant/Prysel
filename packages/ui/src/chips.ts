import type { ValueType } from '@prysel/morphology'
import type { SemanticEdge } from '@prysel/spatial'
import type { CanvasNode } from './Canvas.tsx'

/**
 * Los chips: las variables y constantes que se inicializan al principio de un contexto (el
 * programa, una función, un bucle).
 *
 * Un valor suelto no merece una tarjeta: se dibuja como una píldora compacta, y todas las de un
 * contexto se agrupan en una cajita en su cabecera. Su papel es **alimentar** a otros nodos: se
 * arrastran hasta una casilla que recibe un valor, y esa casilla enseña el chip. La conexión no se
 * dibuja como un cable; se ve porque el chip está en la casilla.
 *
 * Todo aquí es puro (posiciones y tamaños), para probarlo sin navegador.
 */

/** Los tipos de nodo que se dibujan como chip: los valores escalares. */
const CHIP_KINDS: ReadonlySet<string> = new Set([
  'value.number',
  'value.str',
  'value.bool',
  'value.none',
])

/** ¿Es un valor que se dibuja como chip? Tiene que dejar definido un nombre (`x = 5`). */
export const isChipKind = (node: Pick<CanvasNode, 'kind' | 'provides'>): boolean =>
  CHIP_KINDS.has(node.kind) && node.provides !== undefined

/** Un chip que representa una función del programa: se arrastra a una llamada. */
export interface FunctionChip {
  /** El id de la definición. */
  id: string
  name: string
  /** `(a, b)`: lo que recibe. */
  signature: string
  params: readonly string[]
}

export const CHIP_H = 28

/** La cajita de chips de un contexto. */
export const TRAY = {
  pad: 8,
  gap: 6,
  /** Ancho a partir del cual los chips saltan de fila. */
  maxW: 460,
  /** Ancho del botón de añadir, con y sin texto. */
  addW: 30,
  addLabelW: 98,
  /** Aire entre la cajita y lo que hay debajo. */
  below: 10,
} as const

const CHAR = 7.4

/** Lo que enseña un chip como valor: `5`, `"Ana"`, `True`, `None`. */
export function chipValue(node: Pick<CanvasNode, 'control'>): string {
  const control = node.control
  switch (control?.kind) {
    case 'number':
      return String(control.value)
    case 'text': {
      const short = control.value.length > 14 ? `${control.value.slice(0, 13)}…` : control.value
      return `"${short}"`
    }
    case 'boolean':
      return control.value ? 'True' : 'False'
    default:
      return 'None'
  }
}

/** Lo que mide un chip: un icono, su nombre, el signo igual y su valor. */
export function chipSize(node: Pick<CanvasNode, 'label' | 'control'>): { w: number; h: number } {
  const name = node.label.length * CHAR
  const value = Math.max(chipValue(node).length, 2) * CHAR + 10
  return { w: Math.ceil(30 + name + 14 + value), h: CHIP_H }
}

/** Lo que mide el chip de una función: `ƒ nombre(a, b)`. */
export function functionChipSize(chip: Pick<FunctionChip, 'name' | 'signature'>): {
  w: number
  h: number
} {
  return { w: Math.ceil(34 + (chip.name.length + chip.signature.length) * CHAR), h: CHIP_H }
}

export interface Placed {
  id: string
  x: number
  y: number
}

/** Coloca cajas en filas que saltan al llegar a `maxW`, de izquierda a derecha. */
export function packChips(
  items: readonly { id: string; w: number; h: number }[],
  maxW: number = TRAY.maxW,
  gap: number = TRAY.gap,
): { placed: Placed[]; w: number; h: number } {
  const placed: Placed[] = []
  let x = 0
  let y = 0
  let row = 0
  let width = 0
  for (const item of items) {
    if (x > 0 && x + item.w > maxW) {
      x = 0
      y += row + gap
      row = 0
    }
    placed.push({ id: item.id, x, y })
    x += item.w + gap
    row = Math.max(row, item.h)
    width = Math.max(width, x - gap)
  }
  return { placed, w: width, h: items.length === 0 ? 0 : y + row }
}

export interface TrayLayout {
  /** Lo que mide la cajita, con su margen. */
  w: number
  h: number
  /** Dónde va cada chip, relativo a la esquina de la cajita. */
  chips: Placed[]
  /** Dónde va el botón de añadir, si lo hay. */
  add?: { x: number; y: number; w: number; label: boolean }
}

/**
 * La cajita de un contexto: sus chips y, si se puede editar, el botón de añadir. `null` si no hay
 * nada que enseñar (un lienzo de solo lectura sin ningún chip).
 */
export function trayLayout(
  items: readonly { id: string; w: number; h: number }[],
  canAdd: boolean,
): TrayLayout | null {
  if (items.length === 0 && !canAdd) return null
  const label = items.length === 0
  const addW = label ? TRAY.addLabelW : TRAY.addW
  const all = canAdd ? [...items, { id: '+', w: addW, h: CHIP_H }] : [...items]
  const packed = packChips(all)
  const chips = packed.placed
    .filter((p) => p.id !== '+')
    .map((p) => ({ ...p, x: p.x + TRAY.pad, y: p.y + TRAY.pad }))
  const plus = packed.placed.find((p) => p.id === '+')
  return {
    w: packed.w + TRAY.pad * 2,
    h: packed.h + TRAY.pad * 2,
    chips,
    ...(plus ? { add: { x: plus.x + TRAY.pad, y: plus.y + TRAY.pad, w: addW, label } } : {}),
  }
}

/** El contexto del programa entero (los chips que no están dentro de ninguna función ni bucle). */
export const MODULE = 'module'

/**
 * Lo que empieza a **actuar** en un bloque. Las inicializaciones (un valor, una lista, un import, una
 * función definida) no cuentan: mientras solo haya eso, se está preparando el contexto.
 */
const SETUP_KINDS: ReadonlySet<string> = new Set([
  'value.number',
  'value.str',
  'value.bool',
  'value.none',
  'data.list',
  'data.dict',
  'external.import',
  'abstraction.collapsed',
])

/**
 * A qué contexto pertenece cada chip.
 *
 * **Cuándo es un chip y cuándo un nodo con cable.** Un chip es una *inicialización*: un valor
 * escalar con nombre (`limite = 20`) que el contexto prepara antes de empezar a actuar. Solo cuenta si
 * es una sentencia del propio bloque (no de una rama de un `if`) y viene antes de la primera que
 * actúa (una llamada, una operación, un bucle…). Tiene nombre y valor, y no depende de nada: se
 * porta, no se sigue. Todo lo que se calcula, lo que llega de fuera (`input`), la variable de un bucle
 * o un parámetro tiene procedencia y orden, y eso es un cable. Un valor asignado a mitad de camino,
 * o solo en una rama, es parte del flujo: sigue siendo una píldora, pero en su sitio y con cable.
 *
 * El contexto es la función o el bucle que posee el chip, y solo si se dibuja como territorio: si
 * dentro solo hubiera chips no tendría cuerpo, y se quedarían como nodos más. Los del programa
 * (sin dueño) van a la cajita del programa.
 */
export function dockChips(nodes: readonly CanvasNode[]): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const chips = nodes.filter(isChipKind)
  const isChip = new Set(chips.map((chip) => chip.id))
  const contexts = nodes.filter(
    (node) =>
      (node.kind === 'abstraction.collapsed' || node.kind === 'control.loop') &&
      (node.contains?.length ?? 0) > 0,
  )
  const hasBody = (context: CanvasNode) =>
    (context.contains ?? []).some((id) => byId.has(id) && !isChip.has(id))
  const contextIds = new Set(contexts.map((context) => context.id))

  // Las inicializaciones de un bloque: sus sentencias directas, hasta la primera que actúa.
  const leading = new Map<string, Set<string>>()
  const owners = new Set<string>([MODULE, ...contextIds])
  for (const owner of owners) {
    const own = nodes
      .filter((node) => (node.owner ?? MODULE) === owner)
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    const setup = new Set<string>()
    for (const node of own) {
      if (!SETUP_KINDS.has(node.kind)) break
      setup.add(node.id)
    }
    leading.set(owner, setup)
  }

  const docked = new Map<string, string>()
  for (const chip of chips) {
    const owner = chip.owner ?? MODULE
    if (!leading.get(owner)?.has(chip.id)) continue
    if (owner === MODULE) {
      docked.set(chip.id, MODULE)
      continue
    }
    const context = contexts.find((candidate) => candidate.id === owner)
    if (context && hasBody(context)) docked.set(chip.id, owner)
  }
  return docked
}

export interface ChipPlan {
  /** A qué contexto pertenece cada chip acoplado (el id del contexto, o `MODULE`). */
  docked: ReadonlyMap<string, string>
  /** Lo que se coloca en el plano: todo menos los chips acoplados (esos van en su cajita). */
  flowNodes: CanvasNode[]
  /** Las conexiones que se dibujan en el plano: las que salen de un chip acoplado no. */
  flowEdges: SemanticEdge[]
  /** La cajita de cada contexto que tiene una. */
  trays: ReadonlyMap<string, TrayLayout>
  /** Los chips acoplados de cada contexto, en el orden del código. */
  chipsOf: ReadonlyMap<string, CanvasNode[]>
  /** Qué casillas de cada nodo llevan un chip dentro. */
  chipSlots: Readonly<Record<string, Record<string, { name: string; type: ValueType }>>>
  /** Las casillas de cada nodo que solo reciben chips: no necesitan puerto para un cable. */
  chipOnly: Readonly<Record<string, string[]>>
  /** Los chips de función que se ofrecen en la cajita del programa. */
  functions: readonly FunctionChip[]
}

export interface ChipOptions {
  /** Se pueden añadir variables (el lienzo es editable). */
  canAdd: boolean
  /** Las funciones del programa, para ofrecerlas como chips. */
  palette?: readonly FunctionChip[]
  /** La cajita del programa admite añadir (no cuando se ve una sola función). */
  addToModule?: boolean
}

/**
 * Del programa a su reparto en chips: qué va en cada cajita, qué se coloca en el plano y qué
 * casillas llevan ya un chip dentro. Puro: el lienzo solo lo dibuja.
 */
export function planChips(
  nodes: readonly CanvasNode[],
  edges: readonly SemanticEdge[],
  options: ChipOptions,
): ChipPlan {
  const docked = dockChips(nodes)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const functions = options.palette ?? []

  const chipsOf = new Map<string, CanvasNode[]>()
  for (const [id, context] of docked) {
    const chip = byId.get(id)
    if (chip) chipsOf.set(context, [...(chipsOf.get(context) ?? []), chip])
  }
  for (const list of chipsOf.values()) list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))

  const trays = new Map<string, TrayLayout>()
  for (const node of nodes) {
    const hasBody = (node.contains ?? []).some((id) => byId.has(id) && !docked.has(id))
    const isContext = node.kind === 'abstraction.collapsed' || node.kind === 'control.loop'
    if (!isContext || !hasBody) continue
    const items = (chipsOf.get(node.id) ?? []).map((chip) => ({ id: chip.id, ...chipSize(chip) }))
    const tray = trayLayout(items, options.canAdd)
    if (tray) trays.set(node.id, tray)
  }
  const moduleItems = [
    ...(chipsOf.get(MODULE) ?? []).map((chip) => ({ id: chip.id, ...chipSize(chip) })),
    ...functions.map((fn) => ({ id: `fn:${fn.id}`, ...functionChipSize(fn) })),
  ]
  const moduleTray = trayLayout(moduleItems, options.canAdd && options.addToModule !== false)
  if (moduleTray) trays.set(MODULE, moduleTray)

  const chipSlots: Record<string, Record<string, { name: string; type: ValueType }>> = {}
  const fromChips: Record<string, Record<string, number>> = {}
  const total: Record<string, Record<string, number>> = {}
  for (const edge of edges) {
    if (!edge.toPort) continue
    const bucket = (total[edge.to] ??= {})
    bucket[edge.toPort] = (bucket[edge.toPort] ?? 0) + 1
    const from = byId.get(edge.from)
    if (!from || !docked.has(from.id) || from.provides === undefined) continue
    const slots = (chipSlots[edge.to] ??= {})
    slots[edge.toPort] = { name: from.provides, type: from.valueType ?? 'any' }
    const mine = (fromChips[edge.to] ??= {})
    mine[edge.toPort] = (mine[edge.toPort] ?? 0) + 1
  }
  const chipOnly: Record<string, string[]> = {}
  for (const [id, slots] of Object.entries(fromChips)) {
    const only = Object.keys(slots).filter((slot) => slots[slot] === total[id]?.[slot])
    if (only.length > 0) chipOnly[id] = only
  }

  return {
    docked,
    flowNodes: nodes.filter((node) => !docked.has(node.id)),
    flowEdges: edges.filter((edge) => !docked.has(edge.from) && !docked.has(edge.to)),
    trays,
    chipsOf,
    chipSlots,
    chipOnly,
    functions,
  }
}
