import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../Canvas.tsx'
import { Icon } from '../Icon.tsx'
import { VIEWER, gridLayout, viewerImageSize, type ViewerContent } from '../viewer.ts'

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
  // La caja de algo que se está pidiendo: con la forma de lo que va a ser, rellenándose al hablar.
  if (content.ghost && content.draft) {
    const { name, takes = [], does } = content.draft
    return (
      <div
        className="viewer ghost-box"
        data-ghost={content.ghost}
        style={{ width: size.w, minHeight: size.h }}
      >
        <Handle
          type="target"
          id="in"
          position={data.aside ? Position.Right : Position.Left}
          isConnectable={false}
        />
        <header className="ghost-box__head">
          <span className="ghost-box__badge">
            <Icon name={GHOST_ICON[content.ghost]} size={15} />
          </span>
          <span className="ghost-box__kind">{content.title}</span>
          <span className="ghost-box__name" data-empty={name ? undefined : ''} key={name ?? ''}>
            {name ?? '…'}
          </span>
        </header>
        {takes.length > 0 && (
          <div className="ghost-box__takes">
            {takes.map((item) => (
              <span className="ghost-box__chip" key={item}>
                {item}
              </span>
            ))}
          </div>
        )}
        <p className="ghost-box__does">
          {does}
          <span className="ghost-box__caret" aria-hidden />
        </p>
        <div className="ghost-box__lines" aria-hidden>
          <span />
          <span />
          <span />
        </div>
      </div>
    )
  }
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
        {content.steps && content.steps.length > 0 && (
          <ol className="viewer__steps">
            {content.steps.map((step, at) => (
              <li key={at} className="viewer__step">
                <span className="viewer__step-label">{step.label}</span>
                <span className="viewer__step-text">
                  {step.lit
                    ? [...step.text].map((letter, k) => (
                        <span key={k} data-lit={step.lit?.[k] ? '' : undefined}>
                          {letter}
                        </span>
                      ))
                    : step.text}
                </span>
              </li>
            ))}
          </ol>
        )}
        {content.strips && content.strips.length > 0 && (
          <Strips strips={content.strips} width={size.w - 2 * VIEWER.pad - 2} />
        )}
        {content.grids && content.grids.length > 0 && (
          <Grids grids={content.grids} width={size.w} />
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

/**
 * Una lista de números en varios momentos: una tira de barras por momento, todas a la misma escala. Las que
 * ya valen lo que al final van encendidas: se ve cómo la lista se va colocando.
 */
function Strips({
  strips,
  width,
}: {
  strips: NonNullable<ViewerContent['strips']>
  width: number
}) {
  const label = 34
  const room = width - label - 8
  const height = VIEWER.strip - 6
  const all = strips.flatMap((strip) => strip.values)
  const low = Math.min(0, ...all)
  const span = Math.max(...all) - low || 1
  return (
    <ol className="viewer__strips">
      {strips.map((strip, at) => {
        const step = room / Math.max(1, strip.values.length)
        const bar = Math.max(1, Math.min(14, step - 2))
        return (
          <li key={at} className="viewer__strip">
            <span className="viewer__step-label">{strip.label}</span>
            <svg
              width={room}
              height={height}
              viewBox={`0 0 ${room} ${height}`}
              role="img"
              aria-label={`${strip.label}: ${strip.values.join(', ')}`}
            >
              {strip.values.map((value, k) => {
                const tall = Math.max(2, ((value - low) / span) * height)
                return (
                  <rect
                    key={k}
                    x={k * step + (step - bar) / 2}
                    y={height - tall}
                    width={bar}
                    height={tall}
                    rx={1}
                    data-lit={strip.lit?.[k] ? '' : undefined}
                  />
                )
              })}
            </svg>
          </li>
        )
      })}
    </ol>
  )
}

/** Un tablero en varios momentos: una rejilla pequeña por momento, con su rótulo debajo. */
function Grids({ grids, width }: { grids: NonNullable<ViewerContent['grids']>; width: number }) {
  const { cell, w, h } = gridLayout(grids, width)
  return (
    <ol className="viewer__grids">
      {grids.map((grid, at) => (
        <li key={at} className="viewer__grid">
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={grid.label}>
            {grid.cells.flatMap((row, y) =>
              row.map((tone, x) => (
                <rect
                  key={`${x}:${y}`}
                  x={x * cell + 0.5}
                  y={y * cell + 0.5}
                  width={cell - 1}
                  height={cell - 1}
                  rx={cell > 6 ? 1.5 : 0.5}
                  data-tone={tone}
                />
              )),
            )}
          </svg>
          <span className="viewer__grid-label">{grid.label}</span>
        </li>
      ))}
    </ol>
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
