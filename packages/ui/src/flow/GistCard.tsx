import {
  GIST,
  gistConsole,
  gistShape,
  gistStateRows,
  type GistPiece,
  type GistScene,
  type GistValue,
} from '../gist.ts'
import { type CSSProperties, useState } from 'react'
import { Icon } from '../Icon.tsx'

/**
 * La tarjeta «Qué hace» de una función plegada: lo que entró → lo que salió, una vez que se ejecutó de
 * verdad. Se lee sin abrir el diagrama; el botón lo abre.
 */

/** El turno de una celda o una línea dentro de su pieza: las animaciones las van sacando una a una. */
const turn = (index: number, more: CSSProperties = {}): CSSProperties =>
  ({ ...more, '--i': index }) as CSSProperties

function Value({ value, changed }: { value: GistValue; changed?: boolean | undefined }) {
  const shape = gistShape(value)
  const mark = changed ? '' : undefined
  if (shape.as === 'grid') {
    const cols = (shape.rows[0]?.length ?? 0) + (shape.moreCols > 0 ? 1 : 0)
    return (
      <div
        className="gist-grid"
        data-changed={mark}
        style={{
          gridTemplateColumns: `repeat(${cols}, ${shape.cellW}px)`,
          gridAutoRows: GIST.cell,
          gap: GIST.cellGap,
        }}
      >
        {shape.rows.flatMap((row, r) => [
          ...row.map((cell, c) => (
            <span
              key={`${r}:${c}`}
              className="gist-cell"
              data-on={cell === '0' ? undefined : ''}
              style={turn(r + c)}
            >
              {cell}
            </span>
          )),
          ...(shape.moreCols > 0
            ? [
                <span key={`${r}:more`} className="gist-cell" data-more="">
                  …
                </span>,
              ]
            : []),
        ])}
        {shape.moreRows > 0 && (
          <span className="gist-cell" data-more="" style={{ gridColumn: `span ${cols}` }}>
            … {shape.moreRows} más
          </span>
        )}
      </div>
    )
  }
  if (shape.as === 'cells')
    return (
      <div className="gist-cells" data-changed={mark} style={{ gap: GIST.cellGap }}>
        {shape.cells.map((cell, index) => (
          <span
            key={index}
            className="gist-cell"
            data-on=""
            style={turn(index, { width: shape.widths[index], height: GIST.cell })}
          >
            {cell}
          </span>
        ))}
        {shape.more && (
          <span className="gist-cell" data-more="" style={{ width: GIST.cell, height: GIST.cell }}>
            …
          </span>
        )}
      </div>
    )
  if (shape.as === 'pairs')
    return (
      <div className="gist-pairs" data-changed={mark}>
        {[...shape.rows, ...(shape.more ? ['…'] : [])].map((row, index) => (
          <span key={index} className="gist-pair" style={{ height: GIST.row }}>
            {row}
          </span>
        ))}
      </div>
    )
  return (
    <span className="gist-text" data-changed={mark} style={{ height: GIST.cell }}>
      {shape.text}
    </span>
  )
}

function Piece({ piece }: { piece: GistPiece }) {
  if (piece.type === 'datum')
    return (
      <div className="gist-piece">
        {piece.label && <span className="gist-label">{piece.label}</span>}
        <Value value={piece.value} changed={piece.changed} />
      </div>
    )
  if (piece.type === 'console') {
    const { lines, more } = gistConsole(piece.text)
    return (
      <div className="gist-piece">
        <span className="gist-label">consola</span>
        <pre className="gist-console">
          {[...lines, ...(more > 0 ? [`… ${more} más`] : [])].map((line, index) => (
            <span key={index} style={turn(index, { height: GIST.line })}>
              {line === '' ? ' ' : line}
            </span>
          ))}
        </pre>
      </div>
    )
  }
  if (piece.type === 'state') {
    const { rows, more } = gistStateRows(piece)
    return (
      <div className="gist-piece">
        <span className="gist-label">{piece.cls}</span>
        <div className="gist-state">
          {rows.map((row) => (
            <span
              key={row.name}
              className="gist-field"
              data-changed={row.changed ? '' : undefined}
              style={turn(rows.indexOf(row), { height: GIST.row })}
            >
              <span className="gist-field__name">{row.name}</span>
              {row.before !== undefined && (
                <>
                  <s className="gist-field__before">{row.before}</s>
                  <span aria-hidden>→</span>
                </>
              )}
              <span className="gist-field__after">{row.after}</span>
            </span>
          ))}
          {more > 0 && (
            <span className="gist-field" style={{ height: GIST.row }}>
              … {more} más
            </span>
          )}
        </div>
      </div>
    )
  }
  if (piece.type === 'error')
    return (
      <div className="gist-piece">
        <span className="gist-label">falla</span>
        <span className="gist-text" data-error="" style={{ height: GIST.cell }} title={piece.text}>
          {piece.text.length > 40 ? `${piece.text.slice(0, 39)}…` : piece.text}
        </span>
      </div>
    )
  return (
    <span className="gist-note" style={{ height: GIST.cell }} title={piece.text}>
      {piece.text.length > 44 ? `${piece.text.slice(0, 43)}…` : piece.text}
    </span>
  )
}

export interface GistCardProps {
  scene: GistScene
  size: { w: number; h: number }
  /** Abrir el diagrama de la función. */
  onToggle?: (() => void) | undefined
}

export function GistCard({ scene, size, onToggle }: GistCardProps) {
  // Cada vez que se pulsa la flecha, la escena se vuelve a contar desde el principio.
  const [run, setRun] = useState(0)
  return (
    <div
      className="gist-card"
      style={{ width: size.w, height: size.h, padding: GIST.pad }}
      data-stale={scene.stale ? '' : undefined}
      role="group"
      aria-label={`Qué hace ${scene.name}${scene.title ? `: ${scene.title}` : ''}`}
      // Como un nodo: alcanzable por teclado para recorrer el diagrama con un lector de pantalla.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      <header className="gist-card__head" style={{ height: GIST.head }}>
        <span className="gist-card__icon" aria-hidden>
          <Icon name="folder" size={13} />
        </span>
        <span className="gist-card__name">{scene.name}</span>
        {scene.example && (
          <span
            className="gist-card__example"
            title="La entrada es un ejemplo propuesto para probarla. La salida es la que dio el programa al ejecutarse."
          >
            ejemplo
          </span>
        )}
        {onToggle && (
          <button
            type="button"
            className="node__action gist-card__toggle nodrag"
            aria-label={`Ver cómo lo hace ${scene.name}`}
            title="Ver cómo lo hace"
            aria-expanded={false}
            onClick={(event) => {
              event.stopPropagation()
              onToggle()
            }}
          >
            <Icon name="chevron" size={13} />
          </button>
        )}
      </header>
      {scene.title && (
        <p className="gist-card__sub" style={{ height: GIST.sub }} title={scene.title}>
          {scene.title}
        </p>
      )}
      <div key={run} className="gist-card__body" style={{ marginTop: GIST.gap }}>
        {scene.lanes.flatMap((lane, index) => [
          ...(index > 0
            ? [
                <button
                  key={`a${index}`}
                  type="button"
                  className="gist-arrow nodrag"
                  style={turn(index, { width: GIST.arrow })}
                  aria-label="Volver a ver cómo entra y qué sale"
                  title="Volver a verlo"
                  onClick={(event) => {
                    event.stopPropagation()
                    setRun((count) => count + 1)
                  }}
                >
                  →
                </button>,
              ]
            : []),
          <div key={index} className="gist-lane" style={turn(index, { gap: GIST.gap })}>
            {lane.map((piece, at) => (
              <Piece key={at} piece={piece} />
            ))}
          </div>,
        ])}
      </div>
    </div>
  )
}
