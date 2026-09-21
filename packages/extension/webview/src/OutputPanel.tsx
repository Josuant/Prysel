import type { Summary } from '../../src/kernel.ts'
import { describeSummary, type Assets, type RunView } from '../../src/runs.ts'

/**
 * Lo que la última ejecución de un nodo dejó: el error, lo que imprimió, el valor de cada nombre que
 * definió o cambió (con su tipo y su forma), y las figuras. Es de solo lectura y no interpreta nada:
 * todo se enseña como texto, tabla o imagen (`data:`); nunca como HTML que venga del programa.
 */

const STATE_LABEL: Record<RunView['state'], string> = {
  never: 'Sin ejecutar',
  running: 'Ejecutando…',
  fresh: 'Al día',
  stale: 'Desactualizado',
  error: 'Falló',
}

const png = (data: string) => `data:image/png;base64,${data}`

export interface OutputPanelProps {
  /** A qué se refiere: el nombre o la línea del nodo. */
  title: string
  view: RunView
  assets: Assets | undefined
  onClose: () => void
}

export function OutputPanel({ title, view, assets, onClose }: OutputPanelProps) {
  const values = Object.entries(view.values ?? {})
  const empty =
    values.length === 0 &&
    !view.result &&
    !view.stdout &&
    !view.stderr &&
    !view.error &&
    !assets?.figures.length
  return (
    <section
      aria-label={`Salida de ${title}`}
      className="max-h-[42%] min-h-0 overflow-auto border-t border-border-card bg-surface px-3 py-2 text-xs"
    >
      <header className="mb-1.5 flex items-center gap-2">
        <span className="font-semibold text-ink">{title}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${
            view.state === 'error'
              ? 'bg-[var(--chip-error-bg)] text-[var(--chip-error-fg)]'
              : view.state === 'fresh'
                ? 'bg-[var(--chip-success-bg)] text-[var(--chip-success-fg)]'
                : 'bg-[var(--chip-warning-bg)] text-[var(--chip-warning-fg)]'
          }`}
        >
          {STATE_LABEL[view.state]}
        </span>
        {view.ms !== undefined && <span className="text-ink-faint">{formatMs(view.ms)}</span>}
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar la salida"
          className="ml-auto text-ink-faint hover:text-ink"
        >
          ×
        </button>
      </header>

      {view.state === 'stale' && (
        <p className="mb-1.5 text-ink-muted">
          El texto o algo de lo que lee cambió después de ejecutarlo: este resultado puede no valer.
        </p>
      )}
      {view.error && <ErrorBlock error={view.error} />}
      {view.stdout && <Stream label="Salida" text={view.stdout} />}
      {view.stderr && <Stream label="Avisos" text={view.stderr} muted />}
      {view.result && <Value name="valor" summary={view.result} />}
      {values.map(([name, summary]) => (
        <Value key={name} name={name} summary={summary} image={assets?.images[name]} />
      ))}
      {assets?.figures.map((figure, index) => (
        <figure key={index} className="my-2">
          <img
            src={png(figure.data)}
            alt={`Figura ${index + 1} de ${title}`}
            className="max-h-72 max-w-full rounded border border-border-card bg-white"
          />
        </figure>
      ))}
      {empty && view.state !== 'error' && (
        <p className="text-ink-faint">Se ejecutó sin dejar nada que enseñar.</p>
      )}
    </section>
  )
}

const formatMs = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`

function ErrorBlock({ error }: { error: NonNullable<RunView['error']> }) {
  return (
    <div role="alert" className="mb-2 rounded border border-[var(--state-error)] p-2">
      <p className="font-semibold text-[var(--chip-error-fg)]">
        {error.name}
        {error.line !== null && <span className="font-normal"> · línea {error.line}</span>}
      </p>
      <p className="text-ink">{error.message}</p>
      {error.traceback && (
        <pre className="type-code mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-ink-muted">
          {error.traceback}
        </pre>
      )}
    </div>
  )
}

function Stream({ label, text, muted = false }: { label: string; text: string; muted?: boolean }) {
  return (
    <div className="mb-2">
      <p className="mb-0.5 text-[10px] tracking-wide text-ink-faint uppercase">{label}</p>
      <pre
        className={`type-code max-h-40 overflow-auto rounded bg-void px-2 py-1 text-[11px] whitespace-pre-wrap ${
          muted ? 'text-ink-muted' : 'text-ink'
        }`}
      >
        {text}
      </pre>
    </div>
  )
}

function Value({
  name,
  summary,
  image,
}: {
  name: string
  summary: Summary
  image?: string | undefined
}) {
  return (
    <div className="mb-2">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="type-code font-semibold text-ink">{name}</span>
        <span className="text-ink-muted">{describeSummary(summary)}</span>
        {summary.bytes !== undefined && (
          <span className="text-ink-faint">{formatBytes(summary.bytes)}</span>
        )}
      </p>
      {summary.table && <Table table={summary.table} />}
      {image && (
        <img
          src={png(image)}
          alt={`Imagen ${name}`}
          className="mt-1 max-h-48 max-w-full rounded border border-border-card"
        />
      )}
      {summary.sample && (
        <p className="type-code mt-0.5 text-[11px] text-ink-muted">
          {summary.sample.join(', ')}
          {summary.shape && summary.sample.length < product(summary.shape) ? ', …' : ''}
          {summary.range && (
            <span className="text-ink-faint">
              {' '}
              · rango [{summary.range[0]}, {summary.range[1]}]
            </span>
          )}
        </p>
      )}
      {summary.items && (
        <p className="type-code mt-0.5 text-[11px] text-ink-muted">
          {summary.items.join(', ')}
          {summary.length !== undefined && summary.items.length < summary.length ? ', …' : ''}
        </p>
      )}
      {!summary.table && !summary.sample && !summary.items && summary.repr && (
        <p className="type-code mt-0.5 text-[11px] break-all text-ink-muted">{summary.repr}</p>
      )}
    </div>
  )
}

const product = (shape: number[]) => shape.reduce((a, b) => a * b, 1)

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function Table({ table }: { table: NonNullable<Summary['table']> }) {
  return (
    <div className="mt-1 max-w-full overflow-auto rounded border border-border-card">
      <table className="type-code w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th
                key={column.name}
                scope="col"
                className="border-b border-border-card bg-void px-2 py-1 text-left font-semibold text-ink"
              >
                {column.name}
                <span className="block text-[9px] font-normal text-ink-faint">
                  {column.dtype}
                  {column.nulls ? ` · ${column.nulls} nulos` : ''}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="px-2 py-0.5 whitespace-nowrap text-ink-muted">
                  {cell === null ? <span className="text-ink-faint">nulo</span> : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
