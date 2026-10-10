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
  // Dónde empieza el trabajo: una marca sobre su módulo.
  if (figure.kind === 'start')
    return (
      <div className="arch-start" style={{ height: h }} aria-hidden>
        <span className="arch-start__play">▶</span>
        {figure.label}
      </div>
    )
  // Por dónde y cómo se sale de lo que se repite: una marca bajo quien lleva el ciclo.
  if (figure.kind === 'gate')
    return (
      <div className="arch-gate" style={{ width: w, height: h }} aria-hidden>
        <span className="arch-gate__pill">
          <span className="arch-gate__mark">⤷</span>
          {figure.label}
        </span>
      </div>
    )
  // Al reproducir: dónde está ahora. Un marco que va de módulo en módulo.
  if (figure.kind === 'spot')
    return <div className="arch-spot" style={{ width: w, height: h }} aria-hidden />
  if (figure.kind === 'track')
    return (
      <div className="arch-figure" data-kind="track" style={{ width: w, height: h }} aria-hidden>
        <span className="arch-figure__flow" />
      </div>
    )
  // Un embudo (de ancho a estrecho, hacia abajo) o un abanico (de un punto a lo ancho, hacia la derecha).
  if (figure.kind === 'funnel' || figure.kind === 'fan') {
    const narrow = Math.min(w, figure.narrow ?? w * 0.4)
    const points =
      figure.kind === 'funnel'
        ? `0,0 ${w},0 ${(w + narrow) / 2},${h} ${(w - narrow) / 2},${h}`
        : `0,${h / 2 - 10} ${w},0 ${w},${h} 0,${h / 2 + 10}`
    return (
      <svg
        className="arch-figure"
        data-kind={figure.kind}
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        aria-hidden
      >
        <polygon className="arch-figure__shape" points={points} />
      </svg>
    )
  }
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
      {figure.kind === 'ring' && figure.label && (
        // Lo que se repite, y cuántas veces: en el centro del anillo, donde no estorba a nadie.
        <text className="arch-figure__caption" x={w / 2} y={h / 2} textAnchor="middle">
          {figure.label}
        </text>
      )}
    </svg>
  )
}
