import { createContext, type CSSProperties, useContext, useEffect, useState } from 'react'
import {
  GIST,
  gistCases,
  gistConsole,
  gistShape,
  gistStateRows,
  type GistPiece,
  type GistScene,
} from '../gist.ts'
import { Icon } from '../Icon.tsx'

/**
 * La tarjeta «Qué hace» de una función plegada: lo que entró → lo que salió, una vez que se ejecutó de
 * verdad. Se lee sin abrir el diagrama; el botón lo abre.
 *
 * Si la escena tiene **pasos** (una regla que se aplica elemento a elemento), la tarjeta los recorre: cada
 * elemento se enciende cuando le toca, la regla marca por dónde pasa, y su resultado aparece en su sitio. Es
 * la ejecución contada, con los datos de verdad. Pulsar la flecha la vuelve a contar.
 */

/** El turno de una celda o una línea dentro de su pieza: las animaciones las van sacando una a una. */
const turn = (index: number, more: CSSProperties = {}): CSSProperties =>
  ({ ...more, '--i': index }) as CSSProperties

/** Lo que se espera a que la tarjeta haya entrado antes de empezar a recorrer los pasos. */
const START_MS = 1100
/** Lo que dura el recorrido entero, más o menos: con muchos pasos, cada uno es más breve. */
const TOUR_MS = 2800

const still = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** El paso por el que va el recorrido: −1 antes de empezar, e infinito cuando ya acabó (o no lo hay). */
const Beat = createContext(Number.POSITIVE_INFINITY)

function useTour(beats: number): number {
  const none = beats <= 0 || still()
  const [beat, setBeat] = useState(none ? Number.POSITIVE_INFINITY : -1)
  useEffect(() => {
    if (none) return
    const step = Math.min(280, Math.max(45, TOUR_MS / beats))
    let at = -1
    let timer = setTimeout(function tick() {
      at++
      setBeat(at >= beats ? Number.POSITIVE_INFINITY : at)
      if (at < beats) timer = setTimeout(tick, step)
    }, START_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [beats, none])
  return beat
}

type Datum = Extract<GistPiece, { type: 'datum' }>

/** Cómo está una celda en el recorrido: esperando su paso, en él, o ya pasada (y si se quedó fuera). */
function useCell(piece: Pick<Datum, 'beats' | 'fades' | 'arrives'>) {
  const beat = useContext(Beat)
  return (index: number) => {
    const at = piece.beats?.[index]
    if (at === undefined || at === null) return {}
    if (beat < at) return piece.arrives ? { 'data-wait': '' } : {}
    if (beat === at) return { 'data-now': '' }
    return piece.fades?.[index] ? { 'data-out': '' } : {}
  }
}

function Value({ piece }: { piece: Datum }) {
  const shape = gistShape(piece.value)
  const mark = piece.changed ? '' : undefined
  const cell = useCell(piece)
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
          ...row.map((text, c) => (
            <span
              key={`${r}:${c}`}
              className="gist-cell"
              data-on={text === '0' ? undefined : ''}
              style={turn(r + c)}
              {...cell(r * shape.cols + c)}
            >
              {text}
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
        {shape.cells.map((text, index) => (
          <span
            key={index}
            className="gist-cell"
            data-on=""
            style={turn(index, { width: shape.widths[index], height: GIST.cell })}
            {...cell(index)}
          >
            {text}
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
    <span className="gist-text" data-changed={mark} style={{ height: GIST.cell }} {...cell(0)}>
      {shape.text}
    </span>
  )
}

/** La consola. Con pasos, cada carácter aparece cuando le toca a su elemento. */
function Console({ piece }: { piece: Extract<GistPiece, { type: 'console' }> }) {
  const beat = useContext(Beat)
  const { lines, more, offsets } = gistConsole(piece.text)
  return (
    <pre className="gist-console">
      {lines.map((line, index) => (
        <span key={index} style={turn(index, { height: GIST.line })}>
          {line === ''
            ? ' '
            : piece.beats
              ? [...line].map((char, at) => (
                  <i
                    key={at}
                    className="gist-char"
                    data-wait={char !== '…' && beat < (offsets[index] ?? 0) + at ? '' : undefined}
                  >
                    {char}
                  </i>
                ))
              : line}
        </span>
      ))}
      {more > 0 && <span style={turn(lines.length, { height: GIST.line })}>… {more} más</span>}
    </pre>
  )
}

function Piece({ piece }: { piece: GistPiece }) {
  const beat = useContext(Beat)
  if (piece.type === 'datum')
    return (
      <div className="gist-piece">
        {piece.label && <span className="gist-label">{piece.label}</span>}
        <Value piece={piece} />
      </div>
    )
  if (piece.type === 'console')
    return (
      <div className="gist-piece">
        <span className="gist-label">consola</span>
        <Console piece={piece} />
      </div>
    )
  if (piece.type === 'state') {
    const { rows, more } = gistStateRows(piece)
    return (
      <div className="gist-piece">
        <span className="gist-label">{piece.cls}</span>
        <div className="gist-state">
          {rows.map((row, index) => (
            <span
              key={row.name}
              className="gist-field"
              data-changed={row.changed ? '' : undefined}
              style={turn(index, { height: GIST.row })}
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
  if (piece.type === 'rule') {
    const now = piece.via?.[beat]
    return (
      <div className="gist-piece">
        <span className="gist-label">{piece.label}</span>
        <div className="gist-rule" style={{ gap: GIST.cellGap * 2 }}>
          {gistCases(piece).map((entry, index) => (
            <span
              key={index}
              className="gist-case"
              data-now={now === index ? '' : undefined}
              style={turn(index, { height: GIST.cell })}
            >
              <span className="gist-cell" data-on={entry.when === 'otro' ? undefined : ''}>
                {entry.when}
              </span>
              <span className="gist-case__to" aria-hidden>
                →
              </span>
              <span className="gist-cell" data-gives="">
                {entry.gives}
              </span>
            </span>
          ))}
        </div>
      </div>
    )
  }
  if (piece.type === 'test') {
    const verdict = piece.verdicts?.[beat]
    return (
      <div className="gist-piece">
        <span className="gist-label">{piece.label}</span>
        <span
          className="gist-test"
          data-verdict={verdict === undefined ? undefined : verdict ? 'yes' : 'no'}
          style={{ height: GIST.cell }}
          title={piece.text}
        >
          <span className="gist-test__text">
            {piece.text.length > 22 ? `${piece.text.slice(0, 21)}…` : piece.text}
          </span>
          <span className="gist-test__mark" aria-hidden>
            {verdict === undefined ? '?' : verdict ? '✓' : '✗'}
          </span>
        </span>
      </div>
    )
  }
  if (piece.type === 'fold') {
    const running = piece.running ?? []
    const value = beat < 0 ? '·' : (running[Math.min(beat, running.length - 1)] ?? '')
    return (
      <div className="gist-piece">
        <span className="gist-label">{piece.label}</span>
        <span className="gist-fold" style={{ height: GIST.cell }}>
          <span className="gist-fold__symbol" aria-hidden>
            {piece.symbol}
          </span>
          {running.length > 0 && (
            <span key={value} className="gist-fold__value">
              {value}
            </span>
          )}
        </span>
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

/** Los carriles de la escena, con su recorrido. Montarlo de nuevo (otra `key`) lo cuenta desde el principio. */
function Lanes({ scene, onReplay }: { scene: GistScene; onReplay: () => void }) {
  const beat = useTour(scene.beats ?? 0)
  return (
    <Beat.Provider value={beat}>
      <div
        className="gist-card__body"
        style={{ marginTop: GIST.gap }}
        data-touring={Number.isFinite(beat) ? '' : undefined}
      >
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
                    onReplay()
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
    </Beat.Provider>
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
      <Lanes
        key={run}
        scene={scene}
        onReplay={() => {
          setRun((count) => count + 1)
        }}
      />
    </div>
  )
}
