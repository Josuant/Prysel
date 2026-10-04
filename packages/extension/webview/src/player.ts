import type { Program, ProgramNode } from '@prysel/python'
import {
  isShownList,
  visibleLocals,
  type Shown,
  type Trace,
  type TraceState,
} from '../../src/trace.ts'

/**
 * La reproducción de una traza puesta sobre el diagrama: qué nodo es el que se está ejecutando, qué vale
 * cada nombre en este paso y cómo se cuenta lo que acaba de pasar. Puro: recibe el programa y el estado
 * de la traza en un paso (ver `src/trace.ts`).
 */

/** Cómo se lee un valor de la traza: como lo escribiría Python. */
export function formatShown(value: Shown): string {
  if (value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (isShownList(value)) {
    const items = value.l.map((item) => formatShown(item)).join(', ')
    const more = value.n > value.l.length ? ', …' : ''
    if (value.t === 'tuple') return `(${items}${value.l.length === 1 && !more ? ',' : ''}${more})`
    return `[${items}${more}]`
  }
  return String(value)
}

/**
 * El nodo al que corresponde una línea del archivo: el más interno de los que la abarcan. Una cabecera
 * (`for x in y:`) es de su bucle; una línea del cuerpo, de la sentencia que la escribe.
 */
export function nodeAtLine(program: Program, line: number): ProgramNode | undefined {
  let best: ProgramNode | undefined
  for (const node of program.nodes) {
    const end = node.lineEnd ?? node.line
    if (line < node.line || line > end) continue
    if (
      !best ||
      node.line > best.line ||
      (node.line === best.line && end < (best.lineEnd ?? best.line))
    ) {
      best = node
    }
  }
  return best
}

/** La sentencia que envuelve a un nodo (una función, un bucle, una decisión), si la hay. */
const ownerOf = (node: ProgramNode): string | undefined => node.range?.owner

/** El nombre de la función en la que está un nodo (`null`: está en el programa, no en una función). */
export function enclosingFunction(program: Program, node: ProgramNode): string | null {
  return enclosingFunctionNode(program, node)?.label ?? null
}

/**
 * La función (o el método) que envuelve a un nodo: el sitio al que hay que «entrar» para ver su línea de
 * verdad, en vez de solo la llamada que la abrió. `null` si el nodo ya está en el programa (o en una clase,
 * sin estar dentro de ninguno de sus métodos).
 */
export function enclosingFunctionNode(program: Program, node: ProgramNode): ProgramNode | null {
  const byId = new Map(program.nodes.map((n) => [n.id, n]))
  for (let up = ownerOf(node); up !== undefined; up = ownerOf(byId.get(up) ?? node)) {
    const owner = byId.get(up)
    if (!owner) return null
    if (owner.kind === 'abstraction.collapsed') return owner
    if (owner === node) return null
  }
  return null
}

/** El nodo, o el más cercano de los que lo envuelven que sí se ve (una función plegada no enseña su interior). */
export function nearestVisible(
  program: Program,
  node: ProgramNode,
  visible: ReadonlySet<string>,
): string | null {
  const byId = new Map(program.nodes.map((n) => [n.id, n]))
  let found: ProgramNode | undefined = node
  for (let guard = 0; found && !visible.has(found.id) && guard < 32; guard++) {
    const up = ownerOf(found)
    found = up === undefined ? undefined : byId.get(up)
  }
  return found?.id ?? null
}

/**
 * Lo que enseña el diagrama en lugar de una función que no se ve: la llamada que la abre. Es a donde va una
 * nota escrita sobre una línea de dentro de la función.
 */
export function visibleCaller(
  program: Program,
  node: ProgramNode,
  visible: ReadonlySet<string>,
): string | null {
  const byId = new Map(program.nodes.map((n) => [n.id, n]))
  let found: ProgramNode | undefined = node
  for (let guard = 0; found && guard < 32; guard++) {
    if (found.kind === 'abstraction.collapsed') {
      const definition = found
      // Una llamada suelta (`calls`) o metida en una expresión (`total + f(i)`): la que se ve y nombra la función.
      const calls = new RegExp(String.raw`\b${definition.label.replace(/\W/g, '')}\(`)
      const caller = program.nodes.find(
        (n) =>
          visible.has(n.id) &&
          n.id !== definition.id &&
          (n.calls === definition.id || (n.kind !== 'abstraction.collapsed' && calls.test(n.code))),
      )
      if (caller) return caller.id
    }
    const up = ownerOf(found)
    found = up === undefined ? undefined : byId.get(up)
  }
  return null
}

/**
 * Dónde se pone el cursor en un paso: el nodo de la línea en la que está el evento; y si ese nodo no se ve
 * (está dentro de una función plegada), el más cercano que envuelve y sí se ve. Si tampoco hay ninguno,
 * el cursor se queda en la llamada que abrió la función: el diagrama enseña la función como esa llamada.
 */
export function cursorNode(
  program: Program,
  state: TraceState,
  visible: ReadonlySet<string>,
  /**
   * Lo que el lienzo enseña en lugar de un nodo que no se ve (la etapa plegada que lo tiene dentro): se
   * prueba antes que subir por los dueños, que no saben nada de etapas.
   */
  represent?: (id: string) => string | null,
): string | null {
  const event = state.event
  if (!event) return null
  const shown = (line: number): string | null => {
    const node = nodeAtLine(program, line)
    return node ? (represent?.(node.id) ?? nearestVisible(program, node, visible)) : null
  }
  const lines = [event.l, ...state.frames.map((frame) => frame.line).reverse()]
  for (const line of lines) {
    const found = shown(line)
    if (found !== null) return found
  }
  return null
}

/**
 * Construcción progresiva (Fase E): los nodos que la ejecución ya ha tocado hasta este paso (incluido). El
 * resto se atenúa (`modifier: 'pending'`) en vez de dibujarse a todo color desde el principio — «los nodos
 * aparecen a medida que se explican», adaptado a que aquí «explicar» es «ejecutar» (rondas 9-17: casi todo
 * el programa se ve siempre, no solo lo que anota un momento del guion). Un contenedor (función, bucle,
 * decisión) cuenta como tocado en cuanto lo está cualquier línea de su interior, sin recorrer hijos: basta
 * con mirar si su rango `[line, lineEnd]` contiene alguna línea ejecutada. `step` es el índice en
 * `trace.events` (−1: antes de empezar, nada tocado todavía).
 */
export function reachedNodes(program: Program, trace: Trace, step: number): ReadonlySet<string> {
  const lines = new Set<number>()
  for (let i = 0; i <= step && i < trace.events.length; i++) lines.add(trace.events[i]?.l ?? -1)
  const reached = new Set<string>()
  for (const node of program.nodes) {
    // Una función o una clase «se define» (esa línea se ejecuta) mucho antes de llamarla: no cuenta como
    // tocada por su propia cabecera, solo por algo de dentro (`decidir` no se explica hasta que se llama).
    const isDefinition = node.kind === 'abstraction.collapsed' || node.kind === 'abstraction.class'
    const start = isDefinition ? node.line + 1 : node.line
    const end = node.lineEnd ?? node.line
    if (start > end) continue
    for (const line of lines) {
      if (line >= start && line <= end) {
        reached.add(node.id)
        break
      }
    }
  }
  return reached
}

/**
 * Lo que vale, en un paso, cada nombre que define un nodo del programa (lo que enseñan sus chips).
 * `changed` es lo que este paso concreto acaba de escribir (`state.event.ch`): el chip lo anuncia con un
 * pulso al llegar, en vez de aparecer sin más — la versión de «el valor vuela hasta su chip» que encaja
 * con que casi ningún valor lleva ya un cable propio (la mayoría son chips, no cables: rondas 9–17).
 */
export function observedAt(
  program: Program,
  state: TraceState,
): Map<string, Record<string, { short: string; long: string; changed: boolean }>> {
  const changes = state.event?.ch ?? {}
  const found = new Map<string, Record<string, { short: string; long: string; changed: boolean }>>()
  for (const node of program.nodes) {
    const names = node.results ?? (node.provides ? [node.provides] : [])
    if (names.length === 0) continue
    const fn = enclosingFunction(program, node)
    // La llamada más reciente de esa función: en una recursión, la que se está ejecutando.
    const frame = state.frames.findLast((candidate) => candidate.fn === fn)
    if (!frame) continue
    const values: Record<string, { short: string; long: string; changed: boolean }> = {}
    for (const name of names) {
      if (!(name in frame.locals)) continue
      const text = formatShown(frame.locals[name] as Shown)
      // El chip es pequeño: una lista larga se recorta ahí, y entera al pasar el puntero.
      values[name] = {
        short: text.length > 22 ? `${text.slice(0, 21)}…` : text,
        long: `${name} = ${text}`,
        changed: name in changes,
      }
    }
    if (Object.keys(values).length > 0) found.set(node.id, values)
  }
  return found
}

/** Una frase con lo que acaba de pasar en este paso, para el pie del reproductor. */
export function describeEvent(program: Program, state: TraceState): string {
  const event = state.event
  if (!event) return 'Antes de empezar'
  switch (event.k) {
    case 'call': {
      const args = Object.entries(event.ch ?? {})
        .map(([name, value]) => `${name}=${formatShown(value)}`)
        .join(', ')
      return `Entra en ${event.fn ?? 'la función'}(${args})`
    }
    case 'return':
      return `Devuelve ${formatShown(event.v ?? null)}`
    case 'exception':
      return `Falla: ${event.e ?? 'error'}`
    case 'end':
      return 'El programa termina'
    default: {
      const node = nodeAtLine(program, event.l)
      const first = (node?.text ?? node?.code ?? '').split('\n')[0]?.trim() ?? ''
      return first === '' ? `Línea ${event.l}` : first
    }
  }
}

/** Las variables que se ven en un paso, de la llamada actual hacia el programa, listas para enseñar. */
export function variablesAt(state: TraceState): { name: string; text: string; changed: boolean }[] {
  const changes = state.event?.ch ?? {}
  return visibleLocals(state).map(({ name, value }) => ({
    name,
    text: formatShown(value),
    changed: name in changes,
  }))
}
