import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'

/**
 * **Las perillas, como un nodo más.** Los números con los que se puede jugar (con cuántos empieza, cuántas
 * vueltas da) viven en el diagrama, a la entrada del programa: cada uno con su menos, su valor y su más; y,
 * si el programa usa el azar, el dado para volver a tirar. Del nodo sale una flecha a la parte donde está
 * escrito cada número.
 *
 * El nodo no sabe de programas: enseña lo que le dan y avisa de lo que se toca.
 */

export interface KnobItem {
  key: string
  /** Cómo se llama, dicho para leerlo. */
  name: string
  /** De dónde sale (una constante, un dato con el que se arranca) y en qué línea. */
  hint?: string
  /** Su valor, tal como está escrito. */
  text: string
}

export interface KnobsPanel {
  items: readonly KnobItem[]
  /** El programa usa el azar: se puede volver a tirar. */
  chance?: boolean
  /** Subir o bajar una perilla un paso. */
  onStep: (key: string, direction: 1 | -1) => void
  /** Escribirle otro valor (lo que se tecleó: quien lo recibe decide si vale). */
  onSet: (key: string, text: string) => void
  onRoll?: () => void
  /** Las partes del programa donde están escritos esos números: el nodo les tiende una flecha. */
  into?: readonly string[]
}

export const KNOBS_NODE = { w: 244, head: 34, row: 30, foot: 38, pad: 12 }

/** Lo que mide el nodo: su cabecera, una fila por perilla y, si se puede tirar, el dado. */
export const knobsSize = (panel: KnobsPanel): { w: number; h: number } => ({
  w: KNOBS_NODE.w,
  h:
    KNOBS_NODE.head +
    panel.items.length * KNOBS_NODE.row +
    (panel.chance ? KNOBS_NODE.foot : 0) +
    KNOBS_NODE.pad,
})

export interface KnobsNodeData extends Record<string, unknown> {
  panel: KnobsPanel
  size: { w: number; h: number }
  /** Por dónde salen sus flechas: a la derecha (va a la izquierda del dibujo) o abajo (va encima). */
  out: 'right' | 'bottom'
}

export type KnobsFlowNode = Node<KnobsNodeData, 'knobs'>

export function KnobsNode({ data }: NodeProps<KnobsFlowNode>) {
  const { panel, size } = data
  return (
    <div className="knobs-node nodrag nopan" style={{ width: size.w, height: size.h }}>
      <Handle
        type="source"
        id="out"
        position={data.out === 'bottom' ? Position.Bottom : Position.Right}
        isConnectable={false}
        className="note-handle"
      />
      <header className="knobs-node__head">
        <span className="knobs-node__title">Perillas</span>
        <span className="knobs-node__sub">cámbialas y mira qué pasa</span>
      </header>
      <ul className="knobs__list">
        {panel.items.map((item) => (
          <li key={item.key} className="knobs__row">
            <span className="knobs__name" title={item.hint}>
              {item.name}
            </span>
            <button
              type="button"
              className="knobs__step"
              aria-label={`Bajar ${item.name}`}
              onClick={() => {
                panel.onStep(item.key, -1)
              }}
            >
              −
            </button>
            <input
              className="knobs__value"
              inputMode="decimal"
              aria-label={item.name}
              // Con otro valor (lo cambió el programa), la caja vuelve a empezar con él.
              key={item.text}
              defaultValue={item.text}
              onKeyDown={(event) => {
                // Las teclas son del número: ni mueven el lienzo ni borran nada.
                event.stopPropagation()
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
              onBlur={(event) => {
                const typed = event.currentTarget.value.trim()
                if (typed === item.text) return
                // Si no vale, se queda el que había; si vale, llegará escrito de vuelta.
                event.currentTarget.value = item.text
                if (typed !== '') panel.onSet(item.key, typed)
              }}
            />
            <button
              type="button"
              className="knobs__step"
              aria-label={`Subir ${item.name}`}
              onClick={() => {
                panel.onStep(item.key, 1)
              }}
            >
              +
            </button>
          </li>
        ))}
      </ul>
      {panel.chance && (
        <button
          type="button"
          className="knobs__roll knobs-node__roll"
          title="Volver a ejecutarlo con otra suerte: el azar saldrá distinto"
          onClick={panel.onRoll}
        >
          <span aria-hidden>⚄</span> Otra tirada
        </button>
      )}
    </div>
  )
}
