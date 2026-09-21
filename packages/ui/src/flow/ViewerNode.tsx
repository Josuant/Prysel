import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../Canvas.tsx'
import { Icon } from '../Icon.tsx'
import { viewerImageSize, type ViewerContent } from '../viewer.ts'

/**
 * Un visor dentro de React Flow: una ventana con el valor que un nodo dejó al ejecutarse. Solo lee y
 * dibuja; se ajusta a lo que le cabe y se quita con la ×. Recibe un cable del nodo del que sale.
 */

export interface ViewerNodeData extends Record<string, unknown> {
  node: CanvasNode
  content: ViewerContent
  size: { w: number; h: number }
  onUnpin?: (id: string) => void
}

export type ViewerFlowNode = Node<ViewerNodeData, 'viewer'>

export function ViewerNode({ id, data, selected }: NodeProps<ViewerFlowNode>) {
  const { content, size } = data
  const image = viewerImageSize(content, size.w)
  return (
    <div
      className="viewer"
      data-selected={selected ? '' : undefined}
      data-stale={content.stale ? '' : undefined}
      style={{ width: size.w, height: size.h }}
    >
      <Handle type="target" id="in" position={Position.Left} isConnectable={false} />
      <header className="viewer__head">
        <Icon name="chart" size={13} />
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
