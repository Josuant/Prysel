import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from './Icon.tsx'

/** Primitivas de edición. Todo lo que el usuario puede tocar dentro de una tarjeta vive aquí. */

export function Field({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <label className="field">
      {label && <span className="field__label type-field-label">{label}</span>}
      {children}
    </label>
  )
}

export function Row({ children, gap = 'sm' }: { children: ReactNode; gap?: 'sm' | 'md' }) {
  return (
    <div className="row" data-gap={gap}>
      {children}
    </div>
  )
}

/**
 * Un punto del editor al que puede llegar una conexión. El puerto se dibuja a la altura
 * exacta de este campo: así se ve de qué nodo viene cada valor, sin seguir la línea a ojo.
 */
export interface Slot {
  id: string
  label: string
}

/**
 * Un campo de texto se edita en un **borrador** y se confirma al salir de él o con Intro
 * (Esc lo descarta). Confirmar por tecla reescribiría el código a cada pulsación, y a medio
 * escribir casi ningún trozo de Python es válido: el nodo cambiaría de forma bajo los dedos.
 */
function useDraft(value: string, onCommit?: (next: string) => void) {
  const [draft, setDraft] = useState<string | null>(null)
  // Lo último escrito, para que perder el foco confirme lo que hay y no lo que había al pintar.
  const latest = useRef<string | null>(null)
  const set = (next: string | null) => {
    latest.current = next
    setDraft(next)
  }
  return {
    shown: draft ?? value,
    edit: (next: string) => {
      set(next)
    },
    commit: () => {
      const next = latest.current
      set(null)
      if (next !== null && next !== value) onCommit?.(next)
    },
    cancel: () => {
      set(null)
    },
  }
}

/** Intro confirma y Esc descarta. En un área de texto, Intro es un salto de línea: confirma Ctrl+Intro. */
function onKeys(
  editor: { cancel: () => void; commit: () => void },
  multiline: boolean,
): (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void {
  return (event) => {
    if (event.key === 'Escape') {
      editor.cancel()
      event.currentTarget.blur()
    } else if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      // Se confirma aquí, sin esperar al evento de foco: no depende de que la ventana lo reciba.
      editor.commit()
      event.currentTarget.blur()
    }
  }
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono = true,
  grow = true,
  slot,
  linked = false,
  suggestions,
}: {
  value: string
  onChange?: (v: string) => void
  placeholder?: string
  mono?: boolean
  grow?: boolean
  slot?: Slot
  linked?: boolean
  /** Nombres que se pueden usar aquí (las variables definidas antes): se ofrecen al escribir. */
  suggestions?: readonly string[]
}) {
  const editor = useDraft(value, onChange)
  const listId = useId()
  const offered = suggestions !== undefined && suggestions.length > 0 && onChange !== undefined
  return (
    <>
      <input
        list={offered ? listId : undefined}
        className={`input ${mono ? 'type-value' : 'type-field-label'}`}
        data-grow={grow ? '' : undefined}
        data-slot={slot?.id}
        data-slot-label={slot?.label}
        data-linked={linked ? '' : undefined}
        title={linked ? `${slot?.label ?? 'Valor'} viene de otro nodo` : undefined}
        value={editor.shown}
        placeholder={placeholder}
        readOnly={!onChange || linked}
        onChange={(e) => {
          editor.edit(e.target.value)
        }}
        onBlur={editor.commit}
        onKeyDown={onKeys(editor, false)}
      />
      {offered && (
        <datalist id={listId}>
          {suggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
    </>
  )
}

/** Un botón pequeño al final de una fila de un editor: quitar un elemento, añadir uno. */
export function RowButton({
  label,
  icon,
  onClick,
  text,
}: {
  label: string
  icon: 'x' | 'plus'
  onClick: () => void
  text?: string
}) {
  return (
    <button
      type="button"
      className="row-button nodrag"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon name={icon} size={11} />
      {text && <span className="type-field-label">{text}</span>}
    </button>
  )
}

/** Un mensaje de varias líneas: el texto puro, sin comillas ni nada de la sintaxis que lo rodea. */
export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 2,
  slot,
  linked = false,
}: {
  value: string
  onChange?: (v: string) => void
  placeholder?: string
  rows?: number
  slot?: Slot
  linked?: boolean
}) {
  const editor = useDraft(value, onChange)
  return (
    <textarea
      className="input input--area type-value"
      data-grow=""
      data-slot={slot?.id}
      data-slot-label={slot?.label}
      data-linked={linked ? '' : undefined}
      title={linked ? `${slot?.label ?? 'Valor'} viene de otro nodo` : undefined}
      value={editor.shown}
      placeholder={placeholder}
      rows={rows}
      readOnly={!onChange || linked}
      onChange={(e) => {
        editor.edit(e.target.value)
      }}
      onBlur={editor.commit}
      onKeyDown={onKeys(editor, true)}
    />
  )
}

/** Un número cualquiera: se escribe, no se desliza. Para un literal sin rango con sentido. */
export function NumberInput({
  value,
  onChange,
  step = 'any',
  slot,
  linked = false,
}: {
  value: number
  onChange?: (v: number) => void
  step?: number | 'any'
  slot?: Slot
  linked?: boolean
}) {
  // Un número a medio escribir (`-`, `1.`) no es un número: se confirma solo si lo es.
  const editor = useDraft(String(value), (text) => {
    const next = Number(text)
    if (text.trim() !== '' && Number.isFinite(next)) onChange?.(next)
  })
  return (
    <input
      className="input type-value"
      type="number"
      data-grow=""
      data-slot={slot?.id}
      data-slot-label={slot?.label}
      data-linked={linked ? '' : undefined}
      title={linked ? `${slot?.label ?? 'Valor'} viene de otro nodo` : undefined}
      value={editor.shown}
      step={step}
      readOnly={!onChange || linked}
      onChange={(e) => {
        editor.edit(e.target.value)
      }}
      onBlur={editor.commit}
      onKeyDown={onKeys(editor, false)}
    />
  )
}

export function Select({
  value,
  options,
  onChange,
  compact = false,
}: {
  value: string
  options: readonly string[]
  onChange?: (v: string) => void
  compact?: boolean
}) {
  return (
    <span className="select" data-compact={compact ? '' : undefined}>
      <select
        className="select__native type-value"
        value={value}
        disabled={!onChange}
        onChange={(e) => onChange?.(e.target.value)}
        aria-label="Opción"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <Icon name="chevron" size={12} className="select__caret" />
    </span>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange?: (v: number) => void
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100
  return (
    <input
      className="slider"
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      style={{ '--pct': `${pct}%` } as React.CSSProperties}
      onChange={(e) => onChange?.(Number(e.target.value))}
      aria-label="Valor"
    />
  )
}

export function Switch({
  checked,
  labels = ['False', 'True'],
  onChange,
}: {
  checked: boolean
  labels?: [string, string]
  onChange?: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      disabled={!onChange}
      aria-checked={checked}
      aria-label={checked ? labels[1] : labels[0]}
      onClick={() => onChange?.(!checked)}
    >
      <span className="switch__track">
        <span className="switch__knob" />
      </span>
      <span className="type-value">{checked ? labels[1] : labels[0]}</span>
    </button>
  )
}

export function Segmented({
  value,
  options,
  onChange,
}: {
  value: string
  options: readonly string[]
  onChange?: (v: string) => void
}) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className="segmented__item type-field-label"
          aria-pressed={o === value}
          onClick={() => onChange?.(o)}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

export function Chips({
  items,
  onRemove,
  onAdd,
  max = 4,
}: {
  items: string[]
  onRemove?: (index: number) => void
  /** Sin él, la lista solo se lee. Con él, se escribe un elemento nuevo y se añade con Intro o al salir. */
  onAdd?: (item: string) => void
  max?: number
}) {
  const shown = items.slice(0, max)
  const [draft, setDraft] = useState('')
  const commit = () => {
    const item = draft.trim()
    setDraft('')
    if (item) onAdd?.(item)
  }
  return (
    <div className="chips">
      {shown.map((item, i) => (
        <span key={`${item}-${i}`} className="chips__item type-value">
          {item}
          {onRemove && (
            <button
              type="button"
              className="chips__remove nodrag"
              aria-label={`Quitar ${item}`}
              onClick={() => {
                onRemove(i)
              }}
            >
              <Icon name="x" size={10} />
            </button>
          )}
        </span>
      ))}
      {items.length > shown.length && (
        <span className="chips__more type-field-label">+{items.length - shown.length}</span>
      )}
      {onAdd && (
        <input
          className="chips__new type-value"
          placeholder="+ elemento"
          aria-label="Añadir elemento"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Escape') {
              setDraft('')
            }
          }}
        />
      )}
    </div>
  )
}

export function MiniTable({
  columns,
  rows,
  sortBy,
  onSort,
  maxRows = 3,
  slot,
  linked = false,
}: {
  columns: string[]
  rows: string[][]
  sortBy?: string
  onSort?: (column: string) => void
  maxRows?: number
  slot?: Slot
  linked?: boolean
}) {
  return (
    <div
      className="mini-table"
      data-slot={slot?.id}
      data-slot-label={slot?.label}
      data-linked={linked ? '' : undefined}
    >
      <div className="mini-table__head">
        {columns.map((c) => (
          <button
            key={c}
            type="button"
            className="mini-table__col type-field-label"
            aria-pressed={c === sortBy}
            onClick={() => onSort?.(c)}
          >
            {c}
            {c === sortBy && <Icon name="chevron" size={10} />}
          </button>
        ))}
      </div>
      {rows.slice(0, maxRows).map((row, i) => (
        <div className="mini-table__row" key={i}>
          {row.map((cell, j) => (
            <span key={j} className="mini-table__cell type-value">
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Línea de tendencia de un resultado. Solo dibuja forma: el valor exacto va en el texto. */
export function Sparkline({ series, height = 42 }: { series: number[]; height?: number }) {
  const w = 100
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || 1
  const step = series.length > 1 ? w / (series.length - 1) : w
  const points = series.map((v, i) => [i * step, height - ((v - min) / span) * (height - 6) - 3])
  const line = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x?.toFixed(1)} ${y?.toFixed(1)}`)
    .join('')
  const area = `${line}L${w} ${height}L0 ${height}Z`
  const last = points[points.length - 1]
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" aria-hidden>
      <path className="spark__area" d={area} />
      <path className="spark__line" d={line} vectorEffect="non-scaling-stroke" />
      {last && <circle className="spark__dot" cx={last[0]} cy={last[1]} r={2.5} />}
    </svg>
  )
}

export function Progress({ current, total }: { current: number; total: number }) {
  const pct = total === 0 ? 0 : Math.min(100, (current / total) * 100)
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={current}
      aria-valuemin={0}
      aria-valuemax={total}
    >
      <span className="progress__fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

/**
 * Código en crudo. Cuando Prysel no entiende una construcción no inventa una interfaz:
 * deja el texto editable tal cual, que es la única edición honesta posible.
 */
export function CodeBlock({
  source,
  onChange,
  rows = 3,
}: {
  source: string
  onChange?: (v: string) => void
  rows?: number
}) {
  if (!onChange) return <pre className="code-block type-code">{source}</pre>
  return (
    <textarea
      className="code-block type-code"
      value={source}
      rows={rows}
      spellCheck={false}
      aria-label="Código fuente"
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
