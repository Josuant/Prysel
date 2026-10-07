import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../Canvas.tsx'
import { Icon } from '../Icon.tsx'
import { VIEWER, viewerImageSize, type ViewerContent } from '../viewer.ts'

/**
 * Un visor dentro de React Flow: una ventana con el valor que un nodo dejó al ejecutarse. Solo lee y
 * dibuja; se ajusta a lo que le cabe y se quita con la ×. Recibe un cable del nodo del que sale.
 */

export interface ViewerNodeData extends Record<string, unknown> {
  node: CanvasNode
  content: ViewerContent
  size: { w: number; h: number }
  /** Está a la izquierda del diagrama: el cable le llega por la derecha. */
  aside?: boolean
  onUnpin?: (id: string) => void
}

export type ViewerFlowNode = Node<ViewerNodeData, 'viewer'>

/** El icono de cada clase de hueco: el mismo que llevará la pieza cuando exista. */
const GHOST_ICON = {
  function: 'function',
  class: 'package',
  loop: 'loop',
  condition: 'branch',
  value: 'hash',
  list: 'list',
  program: 'flag',
  change: 'pencil',
  talk: 'book',
} as const

export function ViewerNode({ id, data, selected }: NodeProps<ViewerFlowNode>) {
  const { content, size } = data
  const image = viewerImageSize(content, size.w)
  return (
    <div
      className="viewer"
      data-selected={selected ? '' : undefined}
      data-stale={content.stale ? '' : undefined}
      data-busy={content.busy ? '' : undefined}
      data-ghost={content.ghost}
      data-aid={content.aid ? '' : undefined}
      style={{ width: size.w, height: size.h }}
    >
      <Handle
        type="target"
        id="in"
        position={data.aside ? Position.Right : Position.Left}
        isConnectable={false}
      />
      <header className="viewer__head">
        <Icon name={content.ghost ? GHOST_ICON[content.ghost] : 'chart'} size={13} />
        <span className="viewer__title" title={content.title}>
          {content.title}
        </span>
        {content.subtitle && (
          <span className="viewer__sub" title={content.subtitle}>
            {content.subtitle}
          </span>
        )}
        {data.onUnpin && (
          <button
            type="button"
            className="viewer__close nodrag"
            aria-label={`Quitar el visor de ${content.title}`}
            title="Quitar el visor"
            onClick={() => {
              data.onUnpin?.(id)
            }}
          >
            ×
          </button>
        )}
      </header>
      <div className="viewer__body nodrag nowheel">
        {content.stale && (
          <p className="viewer__note">Desactualizado: algo cambió después de ejecutarlo.</p>
        )}
        {content.table && (
          <table className="viewer__table">
            <thead>
              <tr>
                {content.table.columns.map((column) => (
                  <th key={column.name} scope="col">
                    {column.name}
                    <span>
                      {column.dtype}
                      {column.nulls ? ` · ${column.nulls} nulos` : ''}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {content.table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell === null ? <i>nulo</i> : String(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {content.series && <Curve series={content.series} width={size.w - 2 * VIEWER.pad - 2} />}
        {content.image && (
          <img
            src={content.image.src}
            alt={`Visor de ${content.title}`}
            width={image.w}
            height={image.h}
            draggable={false}
          />
        )}
        {content.text?.map((line, i) => (
          <p key={i} className="viewer__line">
            {line}
          </p>
        ))}
      </div>
    </div>
  )
}

/** Una curva: una línea que une los valores de cada vuelta, con el mínimo y el máximo a los lados. */
function Curve({ series, width }: { series: NonNullable<ViewerContent['series']>; width: number }) {
  const height = VIEWER.chart
  const pad = 6
  const min = Math.min(...series.values)
  const max = Math.max(...series.values)
  const span = max - min || 1
  const last = Math.max(1, series.n - 1)
  const points = series.values
    .map((value, i) => {
      const x = pad + ((series.at[i] ?? i) / last) * (width - 2 * pad)
      const y = height - pad - ((value - min) / span) * (height - 2 * pad)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      className="viewer__curve"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Curva de ${series.values.length} puntos, de ${min} a ${max}`}
    >
      <polyline points={points} fill="none" />
    </svg>
  )
}
