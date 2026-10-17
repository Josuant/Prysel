import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useRef, useState } from 'react'

/**
 * **Los mandos del programa, como un nodo más.** Lo que se puede ajustar sin tocar el código vive en el
 * diagrama, a la entrada del programa, cada cosa con el mando que pide su dato:
 *
 * - un número, con una **perilla que gira** (se arrastra hacia arriba o hacia abajo, con la rueda o con las
 *   flechas; con doble clic se teclea), y una probabilidad, con su perilla en tantos por ciento;
 * - un sí o no, con un **interruptor**;
 * - un texto, **escribiéndolo**;
 * - un color, con su **muestra**;
 * - unos cuantos valores, como **fichas** (con un clic se reescriben).
 *
 * Si el programa usa el azar, abajo va el dado para volver a tirar. Del nodo sale una flecha a cada parte que
 * usa esos valores. El nodo no sabe de programas: enseña lo que le dan y avisa de lo que se toca (quien lo
 * recibe lo escribe en el código, y el programa se vuelve a ejecutar).
 */

export type KnobControl =
  | {
      type: 'dial'
      value: number
      min: number
      max: number
      step: number
      /** Es una proporción (de 0 a 1): se enseña en tantos por ciento. */
      percent?: boolean
    }
  | { type: 'switch'; value: boolean }
  | { type: 'text'; value: string }
  /** `value`: el color, `#rrggbb`. */
  | { type: 'color'; value: string }
  /** `items`: cada valor, para leerlo; `text`: la lista entera, para reescribirla. */
  | { type: 'list'; items: string[]; text: string }

export interface KnobItem {
  key: string
  /** Cómo se llama, dicho para leerlo. */
  name: string
  /** De dónde sale (una constante, un dato con el que se arranca) y en qué línea. */
  hint?: string
  control: KnobControl
}

/** Lo que se le da a un mando: un número, un sí o no, o un texto (también un color o una lista tecleada). */
export type KnobValue = number | boolean | string

export interface KnobsPanel {
  /** Cómo se llama el nodo («Configuración», «Con qué arranca»…) y, debajo, para qué sirve. */
  title: string
  sub?: string
  items: readonly KnobItem[]
  /** El programa usa el azar: se puede volver a tirar. */
  chance?: boolean
  /** Darle otro valor a un mando (quien lo recibe decide si vale). */
  onSet: (key: string, value: KnobValue) => void
  onRoll?: () => void
  /** Las partes del programa que usan esos valores: el nodo les tiende una flecha. */
  into?: readonly string[]
}

export const KNOBS_NODE = { w: 276, head: 34, dial: 104, row: 34, foot: 38, pad: 14, cols: 3 }

/** Lo que mide el nodo: su cabecera, las perillas de tres en tres, una fila por cada otro mando y el dado. */
export const knobsSize = (
  items: readonly { control: { type: KnobControl['type'] } }[],
  chance: boolean,
): { w: number; h: number } => {
  const dials = items.filter((item) => item.control.type === 'dial').length
  return {
    w: KNOBS_NODE.w,
    h:
      KNOBS_NODE.head +
      Math.ceil(dials / KNOBS_NODE.cols) * KNOBS_NODE.dial +
      (items.length - dials) * KNOBS_NODE.row +
      (chance ? KNOBS_NODE.foot : 0) +
      KNOBS_NODE.pad,
  }
}

export interface KnobsNodeData extends Record<string, unknown> {
  panel: KnobsPanel
  size: { w: number; h: number }
  /** Por dónde salen sus flechas: a la derecha (va a la izquierda del dibujo) o abajo (va encima). */
  out: 'right' | 'bottom'
}

export type KnobsFlowNode = Node<KnobsNodeData, 'knobs'>

export function KnobsNode({ data }: NodeProps<KnobsFlowNode>) {
  const { panel, size } = data
  const dials = panel.items.filter((item) => item.control.type === 'dial')
  const rows = panel.items.filter((item) => item.control.type !== 'dial')
  return (
    <div className="knobs-node nodrag nopan nowheel" style={{ width: size.w, height: size.h }}>
      <Handle
        type="source"
        id="out"
        position={data.out === 'bottom' ? Position.Bottom : Position.Right}
        isConnectable={false}
        className="note-handle"
      />
      <header className="knobs-node__head">
        <span className="knobs-node__title">{panel.title}</span>
        {panel.sub && <span className="knobs-node__sub">{panel.sub}</span>}
      </header>
      {dials.length > 0 && (
        <div className="knobs__dials">
          {dials.map((item) =>
            item.control.type === 'dial' ? (
              <Dial key={item.key} item={item} control={item.control} onSet={panel.onSet} />
            ) : null,
          )}
        </div>
      )}
      {rows.length > 0 && (
        <ul className="knobs__list">
          {rows.map((item) => (
            <li key={item.key} className="knobs__row">
              <span className="knobs__name" title={item.hint}>
                {item.name}
              </span>
              <Control item={item} onSet={panel.onSet} />
            </li>
          ))}
        </ul>
      )}
      {panel.chance && (
        <button
          type="button"
          className="knobs__roll knobs-node__roll"
          title="Volver a ejecutarlo con otra suerte: el azar saldrá distinto"
          onClick={panel.onRoll}
        >
          <span aria-hidden>⚄</span> Otra tirada
        </button>
      )}
    </div>
  )
}

// ───────────────────────── la perilla ─────────────────────────

/** Lo que gira la perilla de un extremo al otro (en grados; el cero, arriba). */
const SWEEP = 270
/** Cuántos píxeles de arrastre recorren la perilla entera. */
const DRAG_SPAN = 160
/** Cuánto se espera tras la rueda o las flechas para escribir el valor (cada escritura vuelve a ejecutar). */
const SETTLE_MS = 450

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const decimalsOf = (value: number) => {
  const text = String(value)
  return text.includes('e-') ? Number(text.split('e-')[1]) : (text.split('.')[1]?.length ?? 0)
}

/** El valor de la perilla, dicho para leerlo: en tantos por ciento si es una proporción. */
export function dialText(control: Extract<KnobControl, { type: 'dial' }>, value: number): string {
  if (control.percent) {
    const percent = Math.round(value * 1000) / 10
    return `${percent}%`
  }
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000)
}

/** Un punto de la circunferencia, a ese ángulo (en grados; el cero, arriba). */
const pointAt = (center: number, radius: number, degrees: number) => {
  const rad = (degrees * Math.PI) / 180
  return { x: center + radius * Math.sin(rad), y: center - radius * Math.cos(rad) }
}

const arcPath = (center: number, radius: number, from: number, to: number) => {
  const start = pointAt(center, radius, from)
  const end = pointAt(center, radius, to)
  const large = to - from > 180 ? 1 : 0
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
}

function Dial({
  item,
  control,
  onSet,
}: {
  item: KnobItem
  control: Extract<KnobControl, { type: 'dial' }>
  onSet: KnobsPanel['onSet']
}) {
  // La escala se queda la que era mientras el valor quepa en ella: si cambiara con cada valor (va de cero a
  // unas veces lo que vale), la perilla saltaría de sitio cada vez que se suelta.
  const [scale, setScale] = useState({
    min: control.min,
    max: control.max,
    step: control.step,
    percent: control.percent === true,
  })
  const fits =
    control.value >= scale.min &&
    control.value <= scale.max &&
    scale.percent === (control.percent === true)
  if (!fits) {
    setScale({
      min: control.min,
      max: control.max,
      step: control.step,
      percent: control.percent === true,
    })
  }
  const { min, max, step } = fits ? scale : control
  // Lo que se está girando (sobre el valor que tenía al empezar: si el programa trae otro, manda el suyo).
  const [live, setLive] = useState<{ value: number; base: number } | null>(null)
  const [typing, setTyping] = useState(false)
  const drag = useRef<{ x: number; y: number; from: number } | null>(null)
  const settle = useRef<number | undefined>(undefined)
  const value = live !== null && live.base === control.value ? live.value : control.value
  const snap = (raw: number) => {
    const snapped = Math.round((raw - min) / step) * step + min
    return Number(clamp(snapped, min, max).toFixed(Math.max(decimalsOf(step), 0)))
  }
  const set = (next: number) => {
    window.clearTimeout(settle.current)
    if (next !== control.value) onSet(item.key, next)
  }
  /** Mover a ese valor y escribirlo en cuanto se deje de mover. */
  const nudge = (next: number) => {
    setLive({ value: next, base: control.value })
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      set(next)
    }, SETTLE_MS)
  }
  const fraction = clamp((value - min) / (max - min || 1), 0, 1)
  const angle = -SWEEP / 2 + fraction * SWEEP
  const pointer = [pointAt(28, 7, angle), pointAt(28, 14, angle)] as const
  // Un valor que se sale de la escala (se tecleó así) se enseña con la perilla en su tope.
  const outside = value < min || value > max
  return (
    <div className="knob" title={item.hint}>
      <div
        className="knob__dial"
        role="slider"
        tabIndex={0}
        aria-label={item.name}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={dialText(control, value)}
        data-turning={live !== null && live.base === control.value ? '' : undefined}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          event.currentTarget.focus()
          drag.current = { x: event.clientX, y: event.clientY, from: value }
        }}
        onPointerMove={(event) => {
          const from = drag.current
          if (!from) return
          // Hacia arriba (o a la derecha) sube; un arrastre de `DRAG_SPAN` píxeles la recorre entera.
          const moved = from.y - event.clientY + (event.clientX - from.x) * 0.6
          setLive({
            value: snap(from.from + (moved / DRAG_SPAN) * (max - min)),
            base: control.value,
          })
        }}
        onPointerUp={() => {
          if (!drag.current) return
          drag.current = null
          if (live !== null && live.base === control.value) set(live.value)
        }}
        onPointerCancel={() => {
          drag.current = null
          setLive(null)
        }}
        onWheel={(event) => {
          nudge(snap(value + (event.deltaY < 0 ? step : -step) * wheelStride(control)))
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          const way =
            event.key === 'ArrowUp' || event.key === 'ArrowRight'
              ? 1
              : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
                ? -1
                : 0
          if (way !== 0) {
            event.preventDefault()
            nudge(snap(value + way * step * (event.shiftKey ? 10 : 1)))
          } else if (event.key === 'Enter') setTyping(true)
        }}
        onDoubleClick={() => {
          setTyping(true)
        }}
      >
        <svg viewBox="0 0 56 56" width="56" height="56" aria-hidden>
          <path className="knob__track" d={arcPath(28, 24, -SWEEP / 2, SWEEP / 2)} />
          {fraction > 0.004 && (
            <path className="knob__fill" d={arcPath(28, 24, -SWEEP / 2, angle)} />
          )}
          <circle className="knob__body" cx="28" cy="28" r="17" />
          <line
            className="knob__pointer"
            x1={pointer[0].x}
            y1={pointer[0].y}
            x2={pointer[1].x}
            y2={pointer[1].y}
          />
        </svg>
      </div>
      {typing ? (
        <input
          className="knob__typed"
          inputMode="decimal"
          aria-label={item.name}
          defaultValue={control.percent ? String(Math.round(value * 1000) / 10) : String(value)}
          // (Al abrirse se escribe en ella: es lo que se pidió con el doble clic.)
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onFocus={(event) => {
            event.currentTarget.select()
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.currentTarget.value = ''
              event.currentTarget.blur()
            }
          }}
          onBlur={(event) => {
            setTyping(false)
            const typed = Number(
              event.currentTarget.value.replace(',', '.').replace('%', '').trim(),
            )
            if (event.currentTarget.value.trim() === '' || !Number.isFinite(typed)) return
            set(control.percent ? typed / 100 : typed)
          }}
        />
      ) : (
        <span className="knob__value" data-outside={outside ? '' : undefined}>
          {dialText(control, value)}
        </span>
      )}
      <span className="knob__name">{item.name}</span>
    </div>
  )
}

/** Cuántos pasos da cada golpe de rueda: en una escala larga, varios (si no, no se llega nunca). */
const wheelStride = (control: { min: number; max: number; step: number }) =>
  Math.max(1, Math.round((control.max - control.min) / control.step / 50))

// ───────────────────────── los demás mandos ─────────────────────────

function Control({ item, onSet }: { item: KnobItem; onSet: KnobsPanel['onSet'] }) {
  const { control } = item
  if (control.type === 'switch') {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={control.value}
        aria-label={item.name}
        className="knobs__switch"
        onClick={() => {
          onSet(item.key, !control.value)
        }}
      >
        <span className="knobs__switch-said">{control.value ? 'Sí' : 'No'}</span>
        <span className="knobs__switch-track" aria-hidden>
          <span className="knobs__switch-thumb" />
        </span>
      </button>
    )
  }
  if (control.type === 'color') return <Swatch item={item} value={control.value} onSet={onSet} />
  if (control.type === 'list') return <Chips item={item} control={control} onSet={onSet} />
  if (control.type === 'text') {
    return (
      <Typed
        name={item.name}
        className="knobs__text"
        text={control.value}
        onDone={(typed) => {
          onSet(item.key, typed)
        }}
      />
    )
  }
  return null
}

/** Una caja de texto que escribe lo tecleado al pulsar Intro o al salir de ella (si cambió). */
function Typed({
  name,
  className,
  text,
  onDone,
  autoFocus = false,
  onLeave,
}: {
  name: string
  className: string
  text: string
  onDone: (typed: string) => void
  autoFocus?: boolean
  onLeave?: () => void
}) {
  return (
    <input
      className={className}
      aria-label={name}
      // Con otro valor (lo cambió el programa), la caja vuelve a empezar con él.
      key={text}
      defaultValue={text}
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={autoFocus}
      spellCheck={false}
      onKeyDown={(event) => {
        // Las teclas son del texto: ni mueven el lienzo ni borran nada.
        event.stopPropagation()
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          event.currentTarget.value = text
          event.currentTarget.blur()
        }
      }}
      onBlur={(event) => {
        onLeave?.()
        const typed = event.currentTarget.value
        if (typed === text) return
        // Si no vale, se queda el que había; si vale, llegará escrito de vuelta.
        event.currentTarget.value = text
        onDone(typed)
      }}
    />
  )
}

function Swatch({
  item,
  value,
  onSet,
}: {
  item: KnobItem
  value: string
  onSet: KnobsPanel['onSet']
}) {
  // Mientras se elige en el selector, el color cambia muchas veces: se escribe cuando se deja de mover.
  const [live, setLive] = useState<{ value: string; base: string } | null>(null)
  const settle = useRef<number | undefined>(undefined)
  const shown = live !== null && live.base === value ? live.value : value
  return (
    <label className="knobs__swatch" title={item.hint}>
      <span className="knobs__swatch-code">{shown}</span>
      <span className="knobs__swatch-chip" style={{ background: shown }} aria-hidden />
      <input
        type="color"
        aria-label={item.name}
        value={shown}
        onChange={(event) => {
          const next = event.currentTarget.value
          setLive({ value: next, base: value })
          window.clearTimeout(settle.current)
          settle.current = window.setTimeout(() => {
            if (next !== value) onSet(item.key, next)
          }, SETTLE_MS * 2)
        }}
      />
    </label>
  )
}

function Chips({
  item,
  control,
  onSet,
}: {
  item: KnobItem
  control: Extract<KnobControl, { type: 'list' }>
  onSet: KnobsPanel['onSet']
}) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <Typed
        name={item.name}
        className="knobs__text"
        text={control.text}
        // (Se abre para escribir en ella: es lo que se pidió con el clic.)
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onLeave={() => {
          setEditing(false)
        }}
        onDone={(typed) => {
          onSet(item.key, typed)
        }}
      />
    )
  }
  return (
    <button
      type="button"
      className="knobs__chips"
      title="Clic para reescribir la lista"
      aria-label={`${item.name}: ${control.items.join(', ')}`}
      onClick={() => {
        setEditing(true)
      }}
    >
      {control.items.length === 0 ? (
        <span className="knobs__chip knobs__chip--empty">vacía</span>
      ) : (
        control.items.map((one, at) => (
          <span key={at} className="knobs__chip">
            {one}
          </span>
        ))
      )}
    </button>
  )
}
