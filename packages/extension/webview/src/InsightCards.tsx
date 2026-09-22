import { useMemo, type ReactNode } from 'react'
import type { Program } from '@prysel/python'
import type { Ask } from '../../src/lesson.ts'
import { stateAt, type TraceIndex, type TraceState } from '../../src/trace.ts'
import {
  INSIGHT_LABELS,
  clip,
  collectionModels,
  indexNames,
  maxDepth,
  memoryModel,
  stackModel,
  treeModel,
  treeStatus,
  variablesModel,
  type CollectionModel,
  type InsightId,
  type MemoryModel,
  type StackModel,
  type TreeModel,
  type VariablesModel,
} from './insights.ts'
import { expectedFor, judge } from './predict.ts'

/**
 * Los nodos para entender: tarjetas de solo lectura que se alimentan de la traza y cambian con cada paso.
 * Viven junto al lienzo y no dentro de él: así se leen siempre a su tamaño, aunque la cámara se aleje, y no
 * se pierden de vista mientras el diagrama se mueve.
 */

function Card({
  title,
  hint,
  children,
  wide,
}: {
  title: string
  hint?: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <section
      aria-label={title}
      className={`flex min-w-0 flex-col rounded-md border border-border-card bg-surface-raised ${
        wide ? 'min-w-[300px] flex-[2_1_300px]' : 'min-w-[220px] flex-[1_1_220px]'
      }`}
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-border-card px-2 py-1">
        <h3 className="text-[11px] font-semibold tracking-wide text-ink-muted">{title}</h3>
        {hint && <span className="text-[10px] text-ink-faint">{hint}</span>}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2">{children}</div>
    </section>
  )
}

const mono = 'type-code text-[11px]'
const flash =
  'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-ink'

// ─── Variables ────────────────────────────────────────────────────────────────────────────────────

function VariablesCard({ model }: { model: VariablesModel }) {
  return (
    <Card
      title="Variables"
      hint={model.title === 'Programa' ? 'el programa' : `en ${model.title}`}
      wide
    >
      {model.columns.length === 0 ? (
        <p className="text-[11px] text-ink-faint">Aún no hay variables.</p>
      ) : (
        <table className={`${mono} border-collapse`}>
          <thead>
            <tr>
              <th className="pr-3 text-left font-normal text-ink-faint" scope="col">
                línea
              </th>
              {model.names.map((name) => (
                <th key={name} scope="col" className="px-2 text-left font-semibold text-ink-muted">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.columns.map((column, i) => {
              const now = i === model.columns.length - 1
              return (
                <tr key={column.step} aria-current={now ? 'step' : undefined}>
                  <th
                    scope="row"
                    className={`pr-3 text-left font-normal ${now ? 'text-ink' : 'text-ink-faint'}`}
                  >
                    {column.line}
                    {now ? ' ◂' : ''}
                  </th>
                  {column.cells.map((cell, k) => (
                    <td
                      key={model.names[k]}
                      className={`border px-2 py-0.5 ${
                        cell?.changed
                          ? flash
                          : now
                            ? 'border-border-card text-ink'
                            : 'border-transparent text-ink-muted'
                      }`}
                    >
                      {cell ? clip(cell.text, 22) : ''}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}

// ─── Pila ─────────────────────────────────────────────────────────────────────────────────────────

function StackCard({ model, capacity }: { model: StackModel; capacity: number }) {
  // El alto se reserva para la pila más profunda de la traza: al apilarse no empuja al resto.
  const rows = Math.min(capacity, 7)
  return (
    <Card title="Pila de llamadas" hint="la de arriba es la que se ejecuta">
      <ol
        className="flex flex-col gap-1"
        style={{ minHeight: rows * 30 }}
        aria-label="Marcos de la pila, de arriba abajo"
      >
        {model.frames.map((frame, i) => (
          <li
            key={frame.id}
            className={`rounded border px-2 py-1 ${
              frame.current ? 'border-[var(--accent)]' : 'border-border-card'
            } ${frame.returning !== null ? 'border-dashed' : ''}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className={`${mono} font-semibold text-ink`}>{frame.title}</span>
              {frame.returning !== null && (
                <span className={`${mono} text-ink`} title="Devuelve este valor">
                  → {clip(frame.returning, 16)}
                </span>
              )}
            </div>
            {frame.locals.length > 0 && (
              <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                {frame.locals.map((local) => (
                  <span
                    key={local.name}
                    className={`${mono} rounded px-1 ${local.changed ? flash : 'text-ink-muted'}`}
                  >
                    {local.name} = {local.text}
                  </span>
                ))}
              </div>
            )}
            {i === model.frames.length - 2 && model.hidden > 0 && (
              <div className="mt-1 text-[10px] text-ink-faint">… {model.hidden} llamadas más</div>
            )}
          </li>
        ))}
      </ol>
    </Card>
  )
}

// ─── Árbol de llamadas ───────────────────────────────────────────────────────────────────────────

const TREE = { slot: 112, node: 100, h: 36, row: 58, pad: 8 }

function TreeCard({ model, step, state }: { model: TreeModel; step: number; state: TraceState }) {
  const current = state.frames[state.frames.length - 1]?.id ?? 0
  const width = model.columns * TREE.slot + TREE.pad * 2
  const height = model.rows * TREE.row + TREE.pad * 2
  const x = (col: number) => TREE.pad + col * TREE.slot + TREE.slot / 2
  const y = (row: number) => TREE.pad + row * TREE.row
  const visible = model.nodes.filter((node) => treeStatus(node, step, current) !== 'hidden')
  const byId = new Map(model.nodes.map((node) => [node.id, node]))
  return (
    <Card title="Árbol de llamadas" hint={model.truncated ? 'recortado' : undefined} wide>
      {model.nodes.length === 0 ? (
        <p className="text-[11px] text-ink-faint">El programa no llama a ninguna función.</p>
      ) : (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Árbol de llamadas: ${visible.length} de ${model.nodes.length} llamadas hechas`}
        >
          {visible.map((node) => {
            const parent = node.parent === null ? undefined : byId.get(node.parent)
            if (!parent) return null
            return (
              <line
                key={`e${node.id}`}
                x1={x(parent.col)}
                y1={y(parent.row) + TREE.h}
                x2={x(node.col)}
                y2={y(node.row)}
                stroke="var(--line)"
                strokeWidth={1.5}
              />
            )
          })}
          {visible.map((node) => {
            const status = treeStatus(node, step, current)
            return (
              <g
                key={node.id}
                transform={`translate(${x(node.col) - TREE.node / 2} ${y(node.row)})`}
              >
                <title>{`${node.label}${node.value !== null && status === 'done' ? ` → ${node.value}` : ''}`}</title>
                <rect
                  width={TREE.node}
                  height={TREE.h}
                  rx={6}
                  fill={status === 'current' ? 'var(--chip-selected-bg)' : 'var(--surface)'}
                  stroke={status === 'current' ? 'var(--accent)' : 'var(--line)'}
                  strokeWidth={status === 'current' ? 2 : 1.2}
                  strokeDasharray={status === 'open' ? '4 3' : undefined}
                />
                <text
                  x={TREE.node / 2}
                  y={15}
                  textAnchor="middle"
                  className="type-code"
                  fontSize={11}
                  fill="var(--ink)"
                >
                  {clip(node.label, 15)}
                </text>
                <text
                  x={TREE.node / 2}
                  y={29}
                  textAnchor="middle"
                  className="type-code"
                  fontSize={10}
                  fill="var(--ink-muted)"
                >
                  {status === 'done' && node.value !== null
                    ? `→ ${node.value}`
                    : status === 'current'
                      ? '◂ aquí'
                      : '…'}
                </text>
              </g>
            )
          })}
        </svg>
      )}
    </Card>
  )
}

// ─── Memoria ─────────────────────────────────────────────────────────────────────────────────────

const MEM = { row: 26, box: 22, left: 130, gap: 46, right: 150 }

function MemoryCard({ model }: { model: MemoryModel }) {
  const rows = Math.max(model.names.length, model.objects.length, 1)
  const height = rows * MEM.row + 8
  const objectRow = new Map(model.objects.map((object, i) => [object.id, i]))
  return (
    <Card title="Memoria" hint="quién apunta a qué" wide>
      {model.names.length === 0 ? (
        <p className="text-[11px] text-ink-faint">Aún no hay nada en memoria.</p>
      ) : (
        <svg
          width={MEM.left + MEM.gap + MEM.right}
          height={height}
          role="img"
          aria-label={`Memoria: ${model.names.length} nombres y ${model.objects.length} objetos`}
        >
          <defs>
            <marker
              id="mem-arrow"
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={6}
              markerHeight={6}
              orient="auto"
            >
              <path d="M1 1L9 5L1 9z" fill="var(--ink-muted)" />
            </marker>
          </defs>
          {model.names.map((entry, i) => {
            const target = entry.object === null ? undefined : objectRow.get(entry.object)
            const from = i * MEM.row + 4 + MEM.box / 2
            return (
              <g key={`${entry.frame}.${entry.name}`}>
                <rect
                  x={0}
                  y={i * MEM.row + 4}
                  width={MEM.left}
                  height={MEM.box}
                  rx={4}
                  fill={entry.changed ? 'var(--chip-selected-bg)' : 'var(--surface)'}
                  stroke={entry.changed ? 'var(--accent)' : 'var(--line)'}
                />
                <text
                  x={6}
                  y={from + 4}
                  className="type-code"
                  fontSize={11}
                  fill="var(--ink-muted)"
                >
                  {clip(`${entry.frame === 'Programa' ? '' : `${entry.frame}.`}${entry.name}`, 10)}
                </text>
                {target === undefined ? (
                  <text
                    x={MEM.left - 6}
                    y={from + 4}
                    textAnchor="end"
                    className="type-code"
                    fontSize={11}
                    fill="var(--ink)"
                  >
                    {clip(entry.text, 8)}
                  </text>
                ) : (
                  <>
                    <circle cx={MEM.left - 12} cy={from} r={3.5} fill="var(--ink-muted)" />
                    <path
                      d={`M${MEM.left - 12} ${from} C ${MEM.left + MEM.gap / 2} ${from}, ${MEM.left + MEM.gap / 2} ${target * MEM.row + 4 + MEM.box / 2}, ${MEM.left + MEM.gap} ${target * MEM.row + 4 + MEM.box / 2}`}
                      fill="none"
                      stroke="var(--ink-muted)"
                      strokeWidth={1.5}
                      markerEnd="url(#mem-arrow)"
                    />
                  </>
                )}
              </g>
            )
          })}
          {model.objects.map((object, i) => {
            const alias = object.owners.length > 1
            return (
              <g key={object.id} transform={`translate(${MEM.left + MEM.gap} ${i * MEM.row + 4})`}>
                <title>{object.owners.join(' y ')}</title>
                <rect
                  width={MEM.right}
                  height={MEM.box}
                  rx={4}
                  fill="var(--surface-raised)"
                  stroke={alias ? 'var(--accent)' : 'var(--line)'}
                  strokeWidth={alias ? 2 : 1}
                />
                <text x={6} y={15} className="type-code" fontSize={11} fill="var(--ink)">
                  {clip(object.text, alias ? 15 : 20)}
                </text>
                {alias && (
                  <text
                    x={MEM.right - 6}
                    y={15}
                    textAnchor="end"
                    fontSize={10}
                    fill="var(--accent)"
                  >
                    ×{object.owners.length}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
    </Card>
  )
}

// ─── Colección viva ──────────────────────────────────────────────────────────────────────────────

function CollectionView({ model }: { model: CollectionModel }) {
  const cell = Math.max(18, Math.min(44, Math.floor(420 / model.items.length)))
  const bars = 64
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 flex items-baseline gap-2">
        <span className={`${mono} font-semibold text-ink`}>{model.name}</span>
        <span className="text-[10px] text-ink-faint">
          {model.size} elementos{model.size > model.items.length ? ' (se ven los primeros)' : ''}
        </span>
      </div>
      <div className="flex" role="list" aria-label={`Elementos de ${model.name}`}>
        {model.items.map((item, i) => {
          const marks = model.pointers.filter((pointer) => pointer.index === i)
          return (
            <div
              key={i}
              role="listitem"
              className="flex flex-col items-stretch"
              style={{ width: cell }}
            >
              <span className="text-center text-[9px] text-ink-faint">{i}</span>
              {model.numeric && item.level !== null ? (
                <div className="flex items-end justify-center" style={{ height: bars }}>
                  <div
                    className={`w-[70%] rounded-t-sm border ${
                      item.changed
                        ? 'border-[var(--accent)] bg-[var(--accent)]'
                        : marks.length > 0
                          ? 'border-[var(--ink-muted)] bg-[var(--ink-muted)]'
                          : 'border-[var(--line)] bg-[var(--line)]'
                    }`}
                    style={{ height: Math.max(4, Math.round(item.level * bars)) }}
                  />
                </div>
              ) : null}
              <span
                className={`${mono} border text-center ${
                  item.changed ? flash : 'border-border-card text-ink'
                }`}
                title={item.text}
              >
                {cell >= 26 ? clip(item.text, Math.floor(cell / 7)) : ''}
              </span>
              <span className="min-h-[14px] text-center text-[10px] font-semibold text-[var(--accent)]">
                {marks.length > 0 ? `▲${marks.map((m) => m.name).join(',')}` : ''}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CollectionCard({ models }: { models: CollectionModel[] }) {
  return (
    <Card title="Colección" hint="lo que cambió, resaltado" wide>
      {models.length === 0 ? (
        <p className="text-[11px] text-ink-faint">No hay ninguna lista corta que enseñar.</p>
      ) : (
        models.map((model) => <CollectionView key={model.name} model={model} />)
      )}
    </Card>
  )
}

// ─── Predicción ──────────────────────────────────────────────────────────────────────────────────

export interface Answer {
  text: string
  checked: boolean
}

function PredictionCard({
  ask,
  expected,
  answer,
  onChange,
}: {
  ask: Ask
  expected: string | null
  answer: Answer
  onChange: (next: Answer) => void
}) {
  const right = answer.checked && expected !== null && judge(answer.text, expected)
  return (
    <Card title="Predicción" hint="antes de ver qué pasa" wide>
      <p className="text-[12px] text-ink">{ask.text}</p>
      <form
        className="mt-1.5 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (answer.text.trim() !== '') onChange({ ...answer, checked: true })
        }}
      >
        <input
          value={answer.text}
          disabled={answer.checked}
          aria-label="Tu respuesta"
          placeholder="Tu respuesta"
          className={`${mono} min-w-32 flex-1 rounded border border-border-card bg-surface px-2 py-1 text-ink`}
          onChange={(event) => {
            onChange({ text: event.target.value, checked: false })
          }}
        />
        {!answer.checked ? (
          <button
            type="submit"
            disabled={answer.text.trim() === ''}
            className="rounded border border-border-card px-2 py-1 text-[11px] text-ink-muted hover:text-ink disabled:opacity-40"
          >
            Comprobar
          </button>
        ) : (
          <button
            type="button"
            className="rounded border border-border-card px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
            onClick={() => {
              onChange({ text: '', checked: false })
            }}
          >
            Otra vez
          </button>
        )}
      </form>
      {answer.checked && (
        <p
          role="status"
          className={`mt-1.5 text-[12px] ${right ? 'text-[var(--chip-success-fg)]' : 'text-[var(--chip-warning-fg)]'}`}
        >
          {expected === null
            ? 'La traza no dice qué pasa aquí.'
            : right
              ? `✓ Correcto: ${expected}`
              : `✗ No exactamente. Pasa esto: ${expected}`}
        </p>
      )}
    </Card>
  )
}

// ─── El conjunto ─────────────────────────────────────────────────────────────────────────────────

export function InsightDock({
  program,
  index,
  step,
  state,
  ids,
  ask,
  askStep,
  answer,
  onAnswer,
  side,
}: {
  program: Program
  index: TraceIndex
  step: number
  state: TraceState
  ids: readonly InsightId[]
  /** La pregunta del momento actual, si la hay, y el paso en el que se plantea. */
  ask?: Ask | undefined
  askStep?: number | undefined
  answer: Answer
  onAnswer: (next: Answer) => void
  /** Las tarjetas se apilan en columna, a la izquierda del lienzo (lo auxiliar va a ese lado), en vez de en fila debajo. */
  side: boolean
}) {
  // Lo que solo depende de la traza y del programa se calcula una vez.
  const tree = useMemo(() => treeModel(index.trace), [index])
  const capacity = useMemo(() => maxDepth(index.trace), [index])
  const indexes = useMemo(() => indexNames(program), [program])
  const wanted = new Set(ids)
  const previous = step > 0 ? stateAt(index, step - 1) : null
  const expected = ask && askStep !== undefined ? expectedFor(index, askStep, ask) : null
  return (
    <aside
      aria-label="Nodos para entender"
      className={`flex gap-2 overflow-auto bg-void p-2 ${
        side
          ? 'order-first w-[380px] shrink-0 flex-col border-r border-border-card [&>section]:min-w-0 [&>section]:flex-none'
          : 'max-h-[42%] flex-wrap border-t border-border-card'
      }`}
    >
      {ask && <PredictionCard ask={ask} expected={expected} answer={answer} onChange={onAnswer} />}
      {wanted.has('variables') && <VariablesCard model={variablesModel(index, step)} />}
      {wanted.has('stack') && <StackCard model={stackModel(state)} capacity={capacity} />}
      {wanted.has('tree') && <TreeCard model={tree} step={step} state={state} />}
      {wanted.has('memory') && <MemoryCard model={memoryModel(state)} />}
      {wanted.has('collection') && (
        <CollectionCard models={collectionModels(state, previous, indexes)} />
      )}
    </aside>
  )
}

/** Los botones que encienden y apagan cada nodo para entender. */
export function InsightToggles({
  ids,
  onToggle,
}: {
  ids: readonly InsightId[]
  onToggle: (id: InsightId) => void
}) {
  return (
    <div
      role="group"
      aria-label="Nodos para entender"
      className="flex flex-wrap items-center gap-1"
    >
      <span className="text-[11px] text-ink-faint">Entender:</span>
      {(Object.keys(INSIGHT_LABELS) as InsightId[]).map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={ids.includes(id)}
          className={`rounded border px-1.5 py-0.5 text-[11px] ${
            ids.includes(id)
              ? 'border-[var(--accent)] text-ink'
              : 'border-border-card text-ink-muted hover:text-ink'
          }`}
          onClick={() => {
            onToggle(id)
          }}
        >
          {INSIGHT_LABELS[id]}
        </button>
      ))}
    </div>
  )
}
