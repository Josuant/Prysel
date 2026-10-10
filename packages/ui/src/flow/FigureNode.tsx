import type { Node, NodeProps } from '@xyflow/react'
import type { Figure } from '@prysel/spatial'

/**
 * Una **figura auxiliar** de la arquitectura: un dibujo de fondo que dice la forma del programa antes de leer
 * una sola flecha. Un anillo para lo que se repite, unas bandas para lo que va por capas, un halo alrededor de
 * quien reparte el trabajo, un carril bajo lo que pasa de mano en mano.
 *
 * No es parte del programa: no se selecciona, no se mueve y no estorba al puntero.
 */

export interface FigureNodeData extends Record<string, unknown> {
  figure: Figure
}

export type FigureFlowNode = Node<FigureNodeData, 'figure'>

export function FigureNode({ data }: NodeProps<FigureFlowNode>) {
  const { figure } = data
  const { w, h } = figure
  if (figure.kind === 'band')
    return (
      <div className="arch-figure" data-kind="band" style={{ width: w, height: h }} aria-hidden>
        {figure.label && <span className="arch-figure__label">{figure.label}</span>}
      </div>
    )
  if (figure.kind === 'track')
    return (
      <div className="arch-figure" data-kind="track" style={{ width: w, height: h }} aria-hidden>
        <span className="arch-figure__flow" />
      </div>
    )
  // Un anillo (lo que se repite, con una marca que da vueltas) o un halo (alrededor de quien reparte).
  const pad = 6
  return (
    <svg
      className="arch-figure"
      data-kind={figure.kind}
      width={w + pad * 2}
      height={h + pad * 2}
      style={{ marginLeft: -pad, marginTop: -pad }}
      viewBox={`${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`}
      aria-hidden
    >
      <ellipse className="arch-figure__ring" cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} />
      {figure.kind === 'ring' && (
        <ellipse
          className="arch-figure__turn"
          cx={w / 2}
          cy={h / 2}
          rx={w / 2}
          ry={h / 2}
          pathLength={1}
        />
      )}
    </svg>
  )
}
