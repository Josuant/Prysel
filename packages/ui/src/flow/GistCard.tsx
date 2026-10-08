import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react'
import {
  GIST,
  gistCases,
  gistConsole,
  gistLapColumns,
  gistPieceSize,
  lapItemWidth,
  lapText,
  netDetail,
  netError,
  netHead,
  netRowHeight,
  NET_PART_W,
  SWITCH_COUNT_W,
  SWITCH_PART_W,
  SWITCH_ROW,
  switchText,
  type LapCell,
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

function useTour(beats: number, stepMs?: number): number {
  const none = beats <= 0 || still()
  const [beat, setBeat] = useState(none ? Number.POSITIVE_INFINITY : -1)
  useEffect(() => {
    if (none) return
    const step = stepMs ?? Math.min(280, Math.max(45, TOUR_MS / beats))
    let at = -1
    let timer = setTimeout(function tick() {
      at++
      setBeat(at >= beats ? Number.POSITIVE_INFINITY : at)
      if (at < beats) timer = setTimeout(tick, step)
    }, START_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [beats, none, stepMs])
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
  if (piece.type === 'laps') return <LapsTable piece={piece} />
  if (piece.type === 'net') return <NetPiece piece={piece} />
  if (piece.type === 'switch') return <SwitchPiece piece={piece} />
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

/** Una celda de la tabla de vueltas: su texto, o una lista corta como fila de celdas. */
function LapContent({ cell }: { cell: LapCell }) {
  if (typeof cell === 'string') return <>{lapText(cell)}</>
  return (
    <span className="gist-laps__items">
      {cell.items.map((item, at) => (
        <span
          key={at}
          className="gist-laps__item"
          data-changed={cell.changed[at] ? '' : undefined}
          style={{ width: lapItemWidth(item) }}
        >
          {item.length > 6 ? `${item.slice(0, 5)}…` : item}
        </span>
      ))}
    </span>
  )
}

/**
 * Las vueltas de un bucle: una tabla que se llena vuelta a vuelta. En cada una se enciende lo que tomó y lo
 * que cambió; al acabar, por qué acabó. Sin recorrido (o sin movimiento), se ve entera.
 */
function LapsTable({ piece }: { piece: Extract<GistPiece, { type: 'laps' }> }) {
  const beat = useContext(Beat)
  const widths = gistLapColumns(piece)
  const template = widths.map((width) => `${width}px`).join(' ')
  const row = (key: string, cells: ReactNode[], more: Record<string, string | undefined> = {}) => (
    <div
      key={key}
      className="gist-laps__row"
      style={{ gridTemplateColumns: template, height: GIST.row, gap: GIST.cellGap }}
      {...more}
    >
      {cells}
    </div>
  )
  const finished = !Number.isFinite(beat) || beat >= piece.rows.length
  return (
    <div className="gist-piece">
      <span className="gist-label">{piece.label}</span>
      <div className="gist-laps" role="table" aria-label="Vuelta a vuelta">
        {row('head', [
          <span key="n" className="gist-laps__head" style={{ textAlign: 'right', paddingRight: 6 }}>
            {piece.counter ?? '#'}
          </span>,
          ...piece.columns.map((name, at) => (
            <span
              key={at}
              className="gist-laps__head"
              data-takes={at < piece.takes ? '' : undefined}
            >
              {lapText(name)}
            </span>
          )),
        ])}
        {piece.start &&
          row('start', [
            <span key="n" className="gist-laps__n">
              antes
            </span>,
            ...piece.columns.map((_, at) => (
              <span key={at} className="gist-laps__cell" data-start="">
                <LapContent cell={piece.start?.[at] ?? ''} />
              </span>
            )),
          ])}
        {piece.rows.flatMap((lap, k) => {
          const number =
            k >= (piece.skipped?.at ?? Number.POSITIVE_INFINITY)
              ? k + (piece.skipped?.count ?? 0) + 1
              : k + 1
          const state = beat < k ? 'wait' : beat === k ? 'now' : 'done'
          return [
            ...(piece.skipped && piece.skipped.at === k
              ? [
                  row(
                    'skip',
                    [
                      <span key="n" className="gist-laps__skip" style={{ gridColumn: '1 / -1' }}>
                        … {piece.skipped.count} vueltas más
                      </span>,
                    ],
                    beat < k ? { 'data-wait': '' } : {},
                  ),
                ]
              : []),
            row(
              `lap${k}`,
              [
                <span key="n" className="gist-laps__n">
                  {number}
                  {lap.exit === 'break' ? ' ⏹' : lap.exit === 'continue' ? ' ↷' : ''}
                </span>,
                ...lap.cells.map((cell, at) => (
                  <span
                    key={at}
                    className="gist-laps__cell"
                    data-takes={at < piece.takes ? '' : undefined}
                    data-changed={lap.changed[at] ? '' : undefined}
                  >
                    <LapContent cell={cell} />
                  </span>
                )),
              ],
              { [`data-${state}`]: '' },
            ),
          ]
        })}
        {row(
          'end',
          [
            <span key="end" className="gist-laps__end" style={{ gridColumn: '1 / -1' }}>
              {piece.end}
            </span>,
          ],
          finished ? {} : { 'data-wait': '' },
        )}
      </div>
    </div>
  )
}

/** Lo que se dice de cada parte de un `try`, según lo que le pasó. */
function netBadge(
  row: Extract<GistPiece, { type: 'net' }>['rows'][number],
  fell: boolean,
): { text: string; tone: string } {
  if (row.state === 'raised') return { text: '✗ salta un error', tone: 'error' }
  if (row.state === 'caught') return { text: '✓ lo atrapa', tone: 'caught' }
  if (row.state === 'ran') return { text: '✓ se ejecuta', tone: 'ran' }
  if (row.part === 'except' && fell) return { text: 'no es su tipo', tone: 'skipped' }
  return { text: 'no hizo falta', tone: 'skipped' }
}

/**
 * Un `try` como una red de seguridad: lo que se intenta arriba y cada cláusula debajo, encendiéndose en orden.
 * Si saltó un error, aparece en la línea que lo lanzó y **cae** hasta el `except` que lo atrapa; si ninguno lo
 * atrapa, cae hasta abajo y se escapa. Sin recorrido (o sin movimiento), se ve entero.
 */
function NetPiece({ piece }: { piece: Extract<GistPiece, { type: 'net' }> }) {
  const beat = useContext(Beat)
  const finished = !Number.isFinite(beat) || beat >= piece.rows.length
  const tops: number[] = []
  let y = 0
  for (const row of piece.rows) {
    tops.push(y)
    y += netRowHeight(row)
  }
  const fall = piece.fall
  const target = fall ? (fall.to ?? piece.rows.length) : 0
  const landed = fall ? finished || beat >= target : false
  const escaped = fall?.to === null
  const chipTop = (landed ? (escaped ? y : (tops[target] ?? 0)) : 0) + 3
  const endTop = escaped ? y + GIST.row : y
  return (
    <div className="gist-piece">
      <span className="gist-label">{piece.label}</span>
      <div
        className="gist-net"
        style={{ width: gistPieceSize(piece).w, height: endTop + GIST.row }}
      >
        {piece.rows.map((row, k) => {
          const state = finished ? 'done' : beat < k ? 'wait' : beat === k ? 'now' : 'done'
          const badge = netBadge(row, Boolean(fall))
          return (
            <div
              key={k}
              className="gist-net__row"
              data-part={row.part}
              data-state={row.state}
              {...{ [`data-${state}`]: '' }}
              style={{ top: tops[k], height: netRowHeight(row) }}
            >
              <span className="gist-net__part" style={{ width: NET_PART_W }}>
                {row.part === 'try'
                  ? 'intenta'
                  : row.part === 'except'
                    ? 'red'
                    : row.part === 'else'
                      ? 'si no falla'
                      : 'al final'}
              </span>
              <span className="gist-net__body">
                <span className="gist-net__line">
                  <code className="gist-net__head">{netHead(row.head)}</code>
                  {!(fall && row.state === 'raised') && (
                    <span className="gist-net__badge" data-tone={badge.tone}>
                      {badge.text}
                    </span>
                  )}
                </span>
                {row.detail && <span className="gist-net__detail">{netDetail(row.detail)}</span>}
              </span>
            </div>
          )
        })}
        {fall && (beat >= 0 || finished) && (
          <span
            className="gist-net__error"
            data-landed={landed ? '' : undefined}
            data-escaped={escaped ? '' : undefined}
            style={{ top: chipTop }}
            title={fall.error}
          >
            {netError(fall.error)}
          </span>
        )}
        <span
          className="gist-net__end"
          data-wait={finished ? undefined : ''}
          style={{ top: endTop, height: GIST.row }}
        >
          {piece.end}
        </span>
      </div>
    </div>
  )
}

/**
 * Un `if` como unas agujas de tren: una fila por brazo. En cada visita, las condiciones se rellenan con los
 * valores de ese momento y dicen sí o no, y una bola cae hasta el brazo por el que siguió (o de largo, si no
 * entró en ninguno). Cada brazo lleva la cuenta. Sin recorrido (o sin movimiento), se ve la última visita y
 * los totales.
 */
function SwitchPiece({ piece }: { piece: Extract<GistPiece, { type: 'switch' }> }) {
  const beat = useContext(Beat)
  const finished = !Number.isFinite(beat) || beat >= piece.visits.length
  const at = finished ? piece.visits.length - 1 : Math.max(beat, 0)
  const visit = beat < 0 ? undefined : piece.visits[at]
  const straight = piece.none > 0 || piece.visits.some((v) => v.arm < 0)
  const lanes = piece.arms.length + (straight ? 1 : 0)
  const height = piece.arms.length * SWITCH_ROW + (straight ? SWITCH_ROW / 2 : 0)
  const count = (arm: number) =>
    finished
      ? arm < 0
        ? piece.none
        : (piece.totals[arm] ?? 0)
      : piece.visits.slice(0, at + 1).filter((v) => v.arm === arm).length
  const ballTop = (arm: number) =>
    arm < 0 ? piece.arms.length * SWITCH_ROW + 4 : arm * SWITCH_ROW + 5
  return (
    <div className="gist-piece">
      <span className="gist-label">{piece.label}</span>
      <div
        className="gist-switch"
        style={{ width: gistPieceSize(piece).w, height: height + GIST.row }}
        data-lanes={lanes}
      >
        {piece.arms.map((arm, k) => {
          const test = visit?.tests[k] ?? null
          const verdict = visit?.verdicts[k] ?? null
          return (
            <div
              key={k}
              className="gist-switch__arm"
              data-taken={visit?.arm === k ? '' : undefined}
              style={{ top: k * SWITCH_ROW, height: SWITCH_ROW }}
            >
              <span className="gist-switch__part" style={{ width: SWITCH_PART_W }}>
                {arm.part}
              </span>
              <span className="gist-switch__body">
                <code className="gist-switch__head">{switchText(arm.head)}</code>
                <span className="gist-switch__test">
                  {test !== null && <code>{switchText(test)}</code>}
                  {verdict !== null && (
                    <span className="gist-switch__verdict" data-yes={verdict ? '' : undefined}>
                      {verdict ? 'sí' : 'no'}
                    </span>
                  )}
                </span>
              </span>
              <span className="gist-switch__count" style={{ width: SWITCH_COUNT_W }}>
                ×{count(k)}
              </span>
            </div>
          )
        })}
        {straight && (
          <div
            className="gist-switch__arm"
            data-straight=""
            data-taken={visit?.arm === -1 ? '' : undefined}
            style={{ top: piece.arms.length * SWITCH_ROW, height: SWITCH_ROW / 2 }}
          >
            <span className="gist-switch__part" style={{ width: SWITCH_PART_W }}>
              de largo
            </span>
            <span className="gist-switch__body" />
            <span className="gist-switch__count" style={{ width: SWITCH_COUNT_W }}>
              ×{count(-1)}
            </span>
          </div>
        )}
        {visit && (
          <span
            key={at}
            className="gist-switch__ball"
            data-still={finished ? '' : undefined}
            style={
              {
                left: SWITCH_PART_W - 6,
                top: ballTop(visit.arm),
                '--from': '0px',
                '--to': `${ballTop(visit.arm)}px`,
              } as CSSProperties
            }
          />
        )}
        <span
          className="gist-switch__end"
          data-wait={finished ? undefined : ''}
          style={{ top: height, height: GIST.row }}
        >
          {piece.end}
        </span>
      </div>
    </div>
  )
}

/** Los carriles de la escena, con su recorrido. Montarlo de nuevo (otra `key`) lo cuenta desde el principio. */
function Lanes({ scene, onReplay }: { scene: GistScene; onReplay: () => void }) {
  const beat = useTour(scene.beats ?? 0, scene.stepMs)
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
      data-block={scene.block}
      aria-label={`${scene.block && scene.block !== 'function' ? 'Cómo funciona' : 'Qué hace'} ${scene.name}${scene.title ? `: ${scene.title}` : ''}`}
      // Como un nodo: alcanzable por teclado para recorrer el diagrama con un lector de pantalla.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      <header className="gist-card__head" style={{ height: GIST.head }}>
        <span className="gist-card__icon" aria-hidden>
          <Icon
            name={
              scene.block === 'loop'
                ? 'loop'
                : scene.block === 'try'
                  ? 'shield'
                  : scene.block === 'class'
                    ? 'package'
                    : scene.block === 'condition'
                      ? 'branch'
                      : 'folder'
            }
            size={13}
          />
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
            aria-label={`Ver el diagrama de ${scene.name}`}
            title="Ver el diagrama"
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
