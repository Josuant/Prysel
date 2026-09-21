import { useCallback, useState } from 'react'
import type { CanvasNode } from '../Canvas.tsx'
import { parseIterChip } from '../chips.ts'
import { checkConnection, convertNotice, type Link } from '../connect.ts'

/**
 * Arrastrar un chip hasta una casilla.
 *
 * Un chip no se mueve libremente: se **lleva** hasta una casilla que recibe un valor, y al soltarlo
 * vuelve a su cajita. Mientras se arrastra, la casilla que hay bajo el puntero dice si lo admitiría
 * (verde) o no (rojo); al soltarlo sobre una que sí, se escribe la conexión en el código.
 *
 * La casilla se busca en el DOM, no en el modelo: es lo único que sabe qué hay bajo el puntero,
 * campos de otros nodos incluidos.
 */

export interface ChipHover {
  nodeId: string
  slot: string
  ok: boolean
  /** Valdría, pero convirtiendo el valor (un texto donde se pide un número). */
  convert?: 'float'
  name?: string
  /** Por qué no valdría, si no vale. */
  reason?: string
}

/** El chip de una función lleva el id de su definición detrás de este prefijo. */
export const FUNCTION_CHIP = 'fn:'

/**
 * De dónde sale el valor de un chip: la variable, la definición de la función, o el puerto de la
 * variable de un bucle.
 */
export function chipSource(chipId: string): { from: string; port?: string } {
  const iter = parseIterChip(chipId)
  if (iter) return { from: iter.loop, port: `param:${iter.name}` }
  return { from: chipId.startsWith(FUNCTION_CHIP) ? chipId.slice(FUNCTION_CHIP.length) : chipId }
}

/** La casilla que hay bajo un punto de la pantalla, y el nodo al que pertenece. */
export function slotAt(x: number, y: number): { nodeId: string; slot: string } | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (!(element instanceof HTMLElement)) continue
    // El propio chip que se arrastra tapa lo que hay debajo: no cuenta.
    if (element.closest('.react-flow__node-chip')) continue
    const field = element.closest<HTMLElement>('[data-slot]') ?? element.closest('.field')
    const slotEl = field?.hasAttribute('data-slot')
      ? field
      : field?.querySelector<HTMLElement>('[data-slot]')
    const slot = slotEl?.dataset['slot']
    const nodeId = slotEl?.closest('.react-flow__node')?.getAttribute('data-id')
    if (slot && nodeId) return { nodeId, slot }
  }
  return null
}

export function useChipDrag({
  lookup,
  onLink,
  onRefuse,
}: {
  lookup: ReadonlyMap<string, CanvasNode>
  onLink: (link: Link) => void
  onRefuse: (reason: string) => void
}) {
  /** Dónde va el chip que se lleva ahora mismo (sigue al puntero; al soltar, vuelve a su sitio). */
  const [carried, setCarried] = useState<{ id: string; position: { x: number; y: number } } | null>(
    null,
  )
  const [hover, setHover] = useState<ChipHover | null>(null)

  const carry = useCallback((id: string, position: { x: number; y: number }) => {
    setCarried({ id, position })
  }, [])

  const over = useCallback(
    (chipId: string, point: { clientX: number; clientY: number }) => {
      const hit = slotAt(point.clientX, point.clientY)
      if (!hit) {
        setHover((previous) => (previous === null ? previous : null))
        return
      }
      const verdict = checkConnection(lookup, {
        ...chipSource(chipId),
        to: hit.nodeId,
        slot: hit.slot,
      })
      setHover((previous) =>
        previous?.nodeId === hit.nodeId &&
        previous.slot === hit.slot &&
        previous.ok === verdict.ok &&
        previous.convert === (verdict.ok ? verdict.convert : undefined)
          ? previous
          : {
              ...hit,
              ok: verdict.ok,
              ...(verdict.ok
                ? { name: verdict.name, ...(verdict.convert ? { convert: verdict.convert } : {}) }
                : { reason: verdict.reason }),
            },
      )
    },
    [lookup],
  )

  const drop = useCallback(
    (chipId: string) => {
      const target = hover
      setCarried(null)
      setHover(null)
      if (!target) return
      if (target.ok) {
        onLink({
          ...chipSource(chipId),
          to: target.nodeId,
          slot: target.slot,
          ...(target.convert ? { convert: target.convert } : {}),
        })
        // Se avisa de que el valor se convirtió por el camino.
        if (target.convert && target.name) onRefuse(convertNotice(target.name))
      } else if (target.reason) onRefuse(target.reason)
    },
    [hover, onLink, onRefuse],
  )

  return { carried, hover, carry, over, drop }
}
