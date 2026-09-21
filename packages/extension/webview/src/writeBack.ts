import type { ControlModel } from '@prysel/morphology'
import type { Program } from '@prysel/python'
import { editsFor, type Change } from '@prysel/python/edits'

/**
 * Escribir de vuelta, con las cautelas que pide hacerlo sobre el archivo de otra persona.
 *
 * Un cambio en el lienzo se traduce a ediciones de texto cuyos desplazamientos valen solo para la
 * versión del documento que se analizó. Si el usuario hace dos cambios seguidos antes de que
 * llegue el texto reanalizado, el segundo se calcularía sobre un texto que ya cambió y el
 * anfitrión lo descartaría. Por eso **solo hay una edición en vuelo**: las demás esperan, y
 * cuando llega el programa nuevo se recalculan contra él.
 *
 * Hay dos clases de cambio:
 * - **de un campo** (`change`): hasta que el texto cambia de verdad, el campo enseña lo que el
 *   usuario escribió (`pending`); si no, volvería un instante al valor viejo.
 * - **de estructura** (`submit`): eliminar, duplicar, añadir, renombrar, escribir como código. Se
 *   guardan como una función del programa, no como ediciones ya calculadas, justo para poder
 *   recalcularlas contra el texto vigente. Si crean algo, se avisa cuando ya existe (`onCreated`).
 *
 * No sabe nada de React ni de VS Code: recibe cómo publicar y a quién avisar.
 */

/** Cuánto se espera al anfitrión antes de dar la edición por perdida y volver a lo que hay. */
export const PATIENCE_MS = 3000

export interface WriteBackOptions {
  post: (message: unknown) => void
  /** Lo que el usuario escribió y el archivo aún no refleja, por nodo. */
  onPending: (pending: Record<string, ControlModel>) => void
  /** Se acaba de crear algo: el programa ya lo tiene, en esta línea. Es lo que permite enfocarlo. */
  onCreated?: (program: Program, line: number) => void
}

export interface WriteBack {
  /** Un campo cambió en el lienzo. */
  change: (id: string, next: ControlModel) => void
  /** Una operación de estructura: se calcula contra el programa vigente cuando le toca. */
  submit: (build: (program: Program) => Change) => void
  /** Llegó el programa reanalizado, con la versión del documento que se analizó. */
  received: (program: Program | null, version: number | null) => void
}

export function createWriteBack({ post, onPending, onCreated }: WriteBackOptions): WriteBack {
  /** Todo lo que el usuario ha escrito en un campo y el archivo aún no refleja. */
  const unconfirmed = new Map<string, ControlModel>()
  /** Lo que ya se mandó: si vuelve sin confirmarse, se rechazó y se abandona (sin reintentos en bucle). */
  const sent = new Set<string>()
  /** Las operaciones de estructura que esperan su turno. */
  const queue: ((program: Program) => Change)[] = []
  /** Dónde va a aparecer lo que la última operación de estructura enviada crea. */
  let creating: number | undefined
  let inflight = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let latest: { program: Program | null; version: number | null } = { program: null, version: null }

  const send = (version: number, edits: Change['edits']) => {
    inflight = true
    post({ type: 'edit', version, edits })
    // Si el anfitrión no contesta, no nos quedamos esperando para siempre.
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      inflight = false
      unconfirmed.clear()
      sent.clear()
      queue.length = 0
      creating = undefined
      onPending({})
    }, PATIENCE_MS)
  }

  const flush = () => {
    const { program, version } = latest
    if (!inflight && program && version !== null) {
      // Primero los campos, que son lo que el usuario está tocando; luego la estructura.
      for (const [id, next] of unconfirmed) {
        if (sent.has(id)) continue
        const node = program.nodes.find((n) => n.id === id)
        const edits = node ? editsFor(node, next) : []
        if (edits.length === 0) {
          unconfirmed.delete(id)
          continue
        }
        sent.add(id)
        send(version, edits)
        break
      }
      while (!inflight && queue.length > 0) {
        const change = queue.shift()?.(program)
        if (!change || change.edits.length === 0) continue
        creating = change.select?.line
        send(version, change.edits)
      }
    }
    onPending(Object.fromEntries(unconfirmed))
  }

  return {
    change(id, next) {
      unconfirmed.set(id, next)
      sent.delete(id)
      flush()
    },

    submit(build) {
      queue.push(build)
      flush()
    },

    received(program, version) {
      latest = { program, version }
      inflight = false
      if (timer) clearTimeout(timer)
      for (const [id, next] of [...unconfirmed]) {
        const node = program?.nodes.find((n) => n.id === id)
        const confirmed =
          node?.control !== undefined && JSON.stringify(node.control) === JSON.stringify(next)
        // Lo confirmado ya está en el archivo; lo enviado y no confirmado se rechazó.
        if (confirmed || sent.has(id)) {
          unconfirmed.delete(id)
          sent.delete(id)
        }
      }
      // Lo que una operación de estructura acaba de crear ya está en el programa: se avisa.
      if (creating !== undefined && program) {
        const line = creating
        creating = undefined
        onCreated?.(program, line)
      }
      flush()
    },
  }
}
