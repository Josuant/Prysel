import {
  isConstantExpression,
  isLineCard,
  isTerritoryKind,
  type ControlModel,
  type Density,
  type ValueType,
} from '@prysel/morphology'
import { channelOf, type SemanticEdge } from '@prysel/spatial'
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

/**
 * Los tipos de nodo que se dibujan como chip: los valores literales con nombre (un número, un texto,
 * un verdadero / falso, `None`) y las colecciones literales (`[1, 2, 3]`, `{"a": 1}`), que se ven
 * resumidas y se editan en un panel.
 */
const CHIP_KINDS: ReadonlySet<string> = new Set([
  'value.number',
  'value.str',
  'value.bool',
  'value.none',
  'data.list',
  'data.dict',
])

/**
 * ¿Es un valor que se dibuja como chip? Tiene que dejar definido un nombre (`x = 5`) y, salvo
 * `None`, que el analizador haya sabido representarlo: una lista con `*resto` no cabe en una píldora.
 */
export const isChipKind = (node: Pick<CanvasNode, 'kind' | 'provides' | 'control'>): boolean =>
  node.provides !== undefined &&
  ((CHIP_KINDS.has(node.kind) &&
    // Una colección que no es un literal (`t = (a, b)`) trae un editor de destino y valor: no es un chip.
    ((node.control !== undefined && node.control.kind !== 'assign') ||
      node.kind === 'value.none')) ||
    // Una operación entre literales (`TAU = 2 * 3.14159`) es una constante: se porta como un valor.
    isConstantOperation(node))

/** Una operación cuyos dos operandos son literales: no depende de nada. */
const isConstantOperation = (node: Pick<CanvasNode, 'kind' | 'control'>): boolean =>
  node.kind === 'transform.operation' && isConstantExpression(node.control)

/**
 * Los nodos que tienen una cajita de variables: una función y todo lo que envuelve un cuerpo (un
 * bucle, un `with`, un `try` y sus cláusulas).
 */
export const isContextKind = (kind: string): boolean =>
  kind === 'abstraction.collapsed' || isTerritoryKind(kind)

/** Un chip que representa una función del programa: se arrastra a una llamada. */
export interface FunctionChip {
  /** El id de la definición. */
  id: string
  name: string
  /** `(a, b)`: lo que recibe. */
  signature: string
  params: readonly string[]
  /** Su línea en el archivo: la cajita en columna la enseña como el número de un paso. */
  line?: number
}

export const CHIP_H = 28

/**
 * El nombre que una operación o una llamada de una línea ofrece como chip: lo que asigna
 * (`A = funcion()`). Ese nombre **es** el título de la tarjeta, y se arrastra hasta una casilla como
 * cualquier chip: así el resultado no necesita un cable por cada sitio donde se usa.
 */
export function resultName(
  node: Pick<CanvasNode, 'kind' | 'control' | 'provides' | 'label'>,
  density: Density,
): string | undefined {
  if (density !== 'normal' || node.provides === undefined || node.label !== node.provides) {
    return undefined
  }
  // Un valor literal ya es un chip por sí mismo; un territorio y una decisión no asignan nada.
  if (isChipKind(node)) return undefined
  if (isLineCard(node.kind, node.control)) return node.provides
  return RESULT_FAMILIES.some((family) => node.kind.startsWith(family)) ? node.provides : undefined
}

/**
 * Los nombres que una línea ofrece como chips: el que asigna (`A = f()`) o, si asigna varios
 * (`a, b = f()`), cada uno. En compacto y en expandido no hay pastillas: la tarjeta lo dice de otro modo.
 */
export function resultNames(
  node: Pick<CanvasNode, 'kind' | 'control' | 'provides' | 'label' | 'results'>,
  density: Density,
): string[] {
  if (density === 'normal' && node.provides === undefined && node.results !== undefined) {
    const lined = isLineCard(node.kind, node.control)
    // Un editor de destino y valor (`a, b = b, a`) lo dice con los mismos chips.
    return lined || RESULT_FAMILIES.some((family) => node.kind.startsWith(family))
      ? [...node.results]
      : []
  }
  const one = resultName(node, density)
  return one === undefined ? [] : [one]
}

/** Las familias de nodo cuyo título es el nombre que asignan: cálculos, efectos, importaciones y datos. */
const RESULT_FAMILIES = ['transform.', 'effect.', 'external.', 'data.', 'value.']

/** ¿Nombra este texto a `name` como una variable entera (no como parte de otra ni como atributo)? */
export function mentions(text: string, name: string): boolean {
  if (name === '') return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w.])${escaped}(?!\\w)`).test(text)
}

/** El texto que hay hoy en una casilla de un editor, si el editor tiene esa casilla. */
export function slotText(control: ControlModel | undefined, slot: string): string | undefined {
  switch (control?.kind) {
    case 'expression':
      return slot === 'left' ? control.left : slot === 'right' ? control.right : undefined
    case 'condition':
      return slot === 'field' ? control.field : slot === 'value' ? control.value : undefined
    case 'loop':
      return slot === 'iterable' ? control.iterable : undefined
    case 'class':
      return slot === 'bases' ? control.bases : undefined
    case 'assign':
      return slot === 'value'
        ? control.value
        : slot === 'destination'
          ? control.destination
          : undefined
    case 'with':
      return slot === 'context' ? control.context : undefined
    case 'handler':
      return slot === 'type' ? control.type : undefined
    case 'args':
      if (slot === 'callee') return control.target
      return slot.startsWith('arg:')
        ? control.args.find((arg) => arg.name === slot.slice('arg:'.length))?.value
        : undefined
    default:
      return undefined
  }
}

/**
 * La variable de iteración de un bucle (`for n in …`) también es un chip: no se inicializa, se
 * **recibe** en cada vuelta, pero se porta igual que una constante. Vive en la cajita del bucle,
 * diferenciada (color y icono del bucle, sin valor), y se suelta en las casillas de dentro: así el
 * cuerpo no se llena de cables desde la cabecera hasta cada uso.
 */
export interface IterVar {
  /** El id del chip: `iter:nombre@id-del-bucle`. */
  id: string
  loop: string
  name: string
}

const ITER = 'iter:'

export const iterChipId = (loop: string, name: string): string => `${ITER}${name}@${loop}`

const RESULT = 'result:'

/** El chip de uno de los resultados de una línea que asigna varios: su nombre y la línea de la que sale. */
export const resultChipId = (node: string, name: string): string => `${RESULT}${name}@${node}`

/** De un id de chip a la línea y el nombre de un resultado suyo, o `null` si es otra cosa. */
export function parseResultChip(id: string): { node: string; name: string } | null {
  if (!id.startsWith(RESULT)) return null
  const at = id.indexOf('@')
  return at < 0 ? null : { name: id.slice(RESULT.length, at), node: id.slice(at + 1) }
}

/** De un id de chip a la variable de bucle que representa, o `null` si es otra cosa. */
export function parseIterChip(id: string): { loop: string; name: string } | null {
  if (!id.startsWith(ITER)) return null
  const at = id.indexOf('@')
  return at < 0 ? null : { name: id.slice(ITER.length, at), loop: id.slice(at + 1) }
}

/** Lo que mide el chip de una variable de bucle: un icono y su nombre. */
export const iterChipSize = (name: string): { w: number; h: number } => ({
  w: Math.ceil(34 + name.length * CHAR),
  h: CHIP_H,
})

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
  /** Hueco a la izquierda de una cajita en columna, para el número de línea de cada chip. */
  number: 26,
} as const

const CHAR = 7.4

/** Un resumen que no pasa de `max` caracteres: el resto va en el panel del chip. */
const summary = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Lo que enseña un chip como valor: `5`, `"Ana"`, `True`, `None`, `[1, 2, 3]`, `{"a": 1}`. */
export function chipValue(node: Pick<CanvasNode, 'control'>): string {
  const control = node.control
  switch (control?.kind) {
    case 'list':
      return summary(`[${control.items.join(', ')}]`, 20)
    case 'dict':
      return summary(
        `{${control.entries.map(([key, value]) => `${key}: ${value}`).join(', ')}}`,
        20,
      )
    case 'expression':
      return summary(`${control.left} ${control.operator} ${control.right}`, 20)
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
  /** Un chip por fila, con hueco para su número de línea: lo que se lee hacia abajo, en orden. */
  column = false,
): TrayLayout | null {
  if (items.length === 0 && !canAdd) return null
  const label = items.length === 0
  const addW = label ? TRAY.addLabelW : TRAY.addW
  const all = canAdd ? [...items, { id: '+', w: addW, h: CHIP_H }] : [...items]
  const packed = packChips(all, column ? 1 : TRAY.maxW)
  const left = TRAY.pad + (column ? TRAY.number : 0)
  const chips = packed.placed
    .filter((p) => p.id !== '+')
    .map((p) => ({ ...p, x: p.x + left, y: p.y + TRAY.pad }))
  const plus = packed.placed.find((p) => p.id === '+')
  return {
    w: packed.w + left + TRAY.pad,
    h: packed.h + TRAY.pad * 2,
    chips,
    ...(plus ? { add: { x: plus.x + left, y: plus.y + TRAY.pad, w: addW, label } } : {}),
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
  'abstraction.class',
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
    (node) => isContextKind(node.kind) && (node.contains?.length ?? 0) > 0,
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
      if (!SETUP_KINDS.has(node.kind) && !isConstantOperation(node)) break
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

/** Lo que lleva una casilla que recibe un chip. `iter`: es la variable de un bucle. */
export interface ChipSlot {
  name: string
  type: ValueType
  iter?: true
  /** Es el parámetro de una función. */
  param?: true
}

export interface ChipPlan {
  /** A qué contexto pertenece cada chip acoplado (el id del contexto, o `MODULE`). */
  docked: ReadonlyMap<string, string>
  /** Lo que se coloca en el plano: todo menos los chips acoplados (esos van en su cajita). */
  flowNodes: CanvasNode[]
  /**
   * Las conexiones con las que se coloca el plano: el orden de ejecución, el control (ramas, bucles) y
   * los datos que aún se dibujan. Los datos que son un chip en una casilla ya no cuentan: solo el
   * orden manda en cómo se reparten los nodos.
   */
  flowEdges: SemanticEdge[]
  /** El orden de ejecución entre lo que se ve, saltando lo que no está en el plano (chips en cajitas). */
  order: SemanticEdge[]
  /** La cajita de cada contexto que tiene una. */
  trays: ReadonlyMap<string, TrayLayout>
  /** Los chips acoplados de cada contexto, en el orden del código. */
  chipsOf: ReadonlyMap<string, CanvasNode[]>
  /** Las variables de iteración de cada bucle con cuerpo: chips en su cajita, no puertos con cables. */
  iterVars: ReadonlyMap<string, IterVar[]>
  /** Los nodos que ofrecen su resultado como chip (`A = funcion()`): llevan su nombre como pastilla. */
  results: ReadonlySet<string>
  /** Las conexiones que no se dibujan porque son un chip en una casilla (constantes, bucles, resultados). */
  hidden: ReadonlySet<SemanticEdge>
  /** Qué casillas de cada nodo llevan un chip dentro. */
  chipSlots: Readonly<Record<string, Record<string, ChipSlot>>>
  /** Las casillas de cada nodo que solo reciben chips: no necesitan puerto para un cable. */
  chipOnly: Readonly<Record<string, string[]>>
  /** Los chips de función que se ofrecen en la cajita del programa. */
  functions: readonly FunctionChip[]
}

/**
 * Si una conexión es la variable de un bucle llegando a una casilla de dentro, el nombre de esa
 * variable: se dibuja como chip en la casilla, no como cable. El retorno de una función no es una
 * casilla (es su puerto): ese cable se queda.
 */
export function iterName(
  iterVars: ReadonlyMap<string, readonly IterVar[]>,
  edge: Pick<SemanticEdge, 'from' | 'fromPort' | 'toPort'>,
): string | undefined {
  if (!edge.fromPort?.startsWith('param:') || edge.toPort === undefined) return undefined
  if (edge.toPort === 'return') return undefined
  const name = edge.fromPort.slice('param:'.length)
  return iterVars.get(edge.from)?.some((v) => v.name === name) ? name : undefined
}

/**
 * El orden de ejecución entre los nodos que se ven. Un nodo que no está en el plano (un chip en su
 * cajita, un retorno que se dibuja como salida de la función) no rompe la cadena: se salta, y su
 * anterior queda unido a su siguiente.
 */
export function contractOrder(
  edges: readonly SemanticEdge[],
  visible: ReadonlySet<string>,
): SemanticEdge[] {
  const next = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.relation !== 'sequence') continue
    const list = next.get(edge.from)
    if (list) list.push(edge.to)
    else next.set(edge.from, [edge.to])
  }
  const out: SemanticEdge[] = []
  const seen = new Set<string>()
  const add = (edge: SemanticEdge) => {
    const key = `${edge.from}|${edge.to}`
    if (seen.has(key) || edge.from === edge.to) return
    seen.add(key)
    out.push(edge)
  }
  for (const edge of edges) {
    if (edge.relation !== 'sequence' || !visible.has(edge.from)) continue
    if (visible.has(edge.to)) {
      add(edge)
      continue
    }
    // Se atraviesa lo que no se ve hasta dar con lo siguiente que sí.
    const stack = [...(next.get(edge.to) ?? [])]
    const visited = new Set<string>([edge.to])
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (visited.has(id)) continue
      visited.add(id)
      if (visible.has(id)) add({ from: edge.from, to: id, relation: 'sequence' })
      else stack.push(...(next.get(id) ?? []))
    }
  }
  return out
}

export interface ChipOptions {
  /** La cajita del programa va en columna (un chip por fila, con su número de línea): el plano se lee hacia abajo. */
  column?: boolean
  /** La densidad con la que se dibuja cada nodo: solo en normal un resultado es un chip. */
  density?: (node: CanvasNode) => Density
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

  const iterVars = new Map<string, IterVar[]>()
  const trays = new Map<string, TrayLayout>()
  for (const node of nodes) {
    const hasBody = (node.contains ?? []).some((id) => byId.has(id) && !docked.has(id))
    if (!isContextKind(node.kind) || !hasBody) continue
    // Un bucle enseña su variable (o las de su patrón), y una función sus parámetros, primero: es lo
    // que llega, antes de lo que se prepara.
    const vars = (node.params ?? []).map((name) => ({
      id: iterChipId(node.id, name),
      loop: node.id,
      name,
    }))
    if (vars.length > 0) iterVars.set(node.id, vars)
    const items = [
      ...vars.map((v) => ({ id: v.id, ...iterChipSize(v.name) })),
      ...(chipsOf.get(node.id) ?? []).map((chip) => ({ id: chip.id, ...chipSize(chip) })),
    ]
    const tray = trayLayout(items, options.canAdd)
    if (tray) trays.set(node.id, tray)
  }
  const moduleItems = [
    ...(chipsOf.get(MODULE) ?? []).map((chip) => ({
      id: chip.id,
      ...chipSize(chip),
      line: chip.line,
    })),
    ...functions.map((fn) => ({ id: `fn:${fn.id}`, ...functionChipSize(fn), line: fn.line })),
  ]
  // En columna, todo va en el orden del código (variables y funciones mezcladas), como los pasos.
  if (options.column === true) {
    moduleItems.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity))
  }
  const moduleTray = trayLayout(
    moduleItems,
    options.canAdd && options.addToModule !== false,
    options.column === true,
  )
  if (moduleTray) trays.set(MODULE, moduleTray)

  const results = new Set(
    nodes
      .filter(
        (node) =>
          options.density !== undefined && resultNames(node, options.density(node)).length > 0,
      )
      .map((node) => node.id),
  )
  /** El nombre con el que un valor llega por esta conexión: el de un parámetro, o lo que define su origen. */
  const nameOf = (edge: SemanticEdge): string | undefined =>
    edge.fromPort?.startsWith('param:')
      ? edge.fromPort.slice('param:'.length)
      : edge.fromPort?.startsWith('result:')
        ? edge.fromPort.slice('result:'.length)
        : byId.get(edge.from)?.provides
  /**
   * Un valor llega a un nodo que ya lo nombra: en su casilla (`x`, o `x + 1`), o en su texto si no tiene
   * casillas. El cable no cuenta nada que no diga ya el nombre, y solo ensucia: no se dibuja. La conexión
   * de un valor sin nombre (`return a + b`) y las de control se quedan. En compacto no hay casillas que
   * lo enseñen, y los cables se conservan.
   */
  const asChip = (edge: SemanticEdge): boolean => {
    if (options.density === undefined) return false
    const to = byId.get(edge.to)
    if (!to || edge.relation === 'feedback' || channelOf(edge) !== 'data') return false
    if (options.density(to) === 'compact') return false
    if (edge.toPort === 'return') return edge.via !== undefined
    const name = nameOf(edge)
    if (name === undefined) return false
    if (edge.toPort === undefined) {
      return mentions(`${to.code ?? ''} ${JSON.stringify(to.control ?? '')}`, name)
    }
    if (!to.inputs?.includes(edge.toPort)) return false
    const text = slotText(to.control, edge.toPort)
    return text !== undefined && mentions(text, name)
  }
  const hidden = new Set<SemanticEdge>()
  const chipSlots: Record<string, Record<string, ChipSlot>> = {}
  const fromChips: Record<string, Record<string, number>> = {}
  const total: Record<string, Record<string, number>> = {}
  for (const edge of edges) {
    if (edge.toPort) {
      const bucket = (total[edge.to] ??= {})
      bucket[edge.toPort] = (bucket[edge.toPort] ?? 0) + 1
    }
    const from = byId.get(edge.from)
    const bound = iterName(iterVars, edge)
    const fromDocked = from !== undefined && docked.has(from.id) && from.provides !== undefined
    if (bound === undefined && !fromDocked && !asChip(edge)) continue
    hidden.add(edge)
    const name = bound ?? nameOf(edge)
    if (!edge.toPort || name === undefined) continue
    // La variable de un bucle y el parámetro de una función se distinguen del resto (y entre sí).
    const owner = edge.fromPort?.startsWith('param:') ? from : undefined
    const slots = (chipSlots[edge.to] ??= {})
    slots[edge.toPort] = owner
      ? owner.kind === 'abstraction.collapsed'
        ? { name, type: 'any', param: true }
        : { name, type: 'any', iter: true }
      : { name, type: from?.valueType ?? 'any' }
    const mine = (fromChips[edge.to] ??= {})
    mine[edge.toPort] = (mine[edge.toPort] ?? 0) + 1
  }
  const chipOnly: Record<string, string[]> = {}
  for (const [id, slots] of Object.entries(fromChips)) {
    const only = Object.keys(slots).filter((slot) => slots[slot] === total[id]?.[slot])
    if (only.length > 0) chipOnly[id] = only
  }

  const flowNodes = nodes.filter((node) => !docked.has(node.id))
  const order = contractOrder(edges, new Set(flowNodes.map((node) => node.id)))

  return {
    docked,
    flowNodes,
    flowEdges: [
      ...edges.filter(
        (edge) =>
          edge.relation !== 'sequence' &&
          !docked.has(edge.from) &&
          !docked.has(edge.to) &&
          !hidden.has(edge),
      ),
      ...order,
    ],
    order,
    trays,
    chipsOf,
    iterVars,
    results,
    hidden,
    chipSlots,
    chipOnly,
    functions,
  }
}

/**
 * A qué sentencia se puede subir un valor del flujo para que sea una inicialización de su contexto:
 * la primera de su bloque (en el programa, tras los \`import\`). \`null\` si no se puede:
 * - no es un valor que se dibuje como chip;
 * - es de una rama de una decisión (subirlo lo volvería incondicional);
 * - ya estaba definido antes (\`x = 1\` … \`x = 5\`): subir el segundo cambiaría lo que ven los usos de entre medias;
 * - ya es la primera sentencia.
 */
export function promoteTarget(nodes: readonly CanvasNode[], node: CanvasNode): string | null {
  if (!isChipKind(node) || node.provides === undefined) return null
  if (node.scope?.includes(node.provides)) return null
  const owner = node.owner
  if (owner !== undefined) {
    const context = nodes.find((candidate) => candidate.id === owner)
    if (!context || !isContextKind(context.kind)) return null
  }
  const first = nodes
    .filter(
      (other) => other.owner === owner && (owner !== undefined || other.kind !== 'external.import'),
    )
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))[0]
  return first && first.id !== node.id && (first.line ?? 0) < (node.line ?? 0) ? first.id : null
}
