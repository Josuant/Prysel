import { useEffect, useRef, useState } from 'react'
import type { NodeProps, Node } from '@xyflow/react'
import { getKind, valueTypeOf, type ControlModel } from '@prysel/morphology'
import type { CanvasNode } from '../Canvas.tsx'
import { chipValue, type FunctionChip } from '../chips.ts'
import { Icon } from '../Icon.tsx'
import { onKeys, useDraft } from '../fields.tsx'
import type { TrayLayout } from '../chips.ts'

/**
 * Un chip: una variable o constante como píldora compacta (`total = 0`), o una función del
 * programa (`ƒ suma(a, b)`). Se arrastra hasta una casilla que reciba un valor. El valor de una
 * variable se edita en su sitio, sin abrir nada.
 */

export interface ChipNodeData extends Record<string, unknown> {
  /** La variable o constante que representa. */
  chip?: CanvasNode
  /** O la función. */
  fn?: FunctionChip
  size: { w: number; h: number }
  onControlChange?: (id: string, next: ControlModel) => void
  onRename?: (id: string, to: string) => void
  /** Sube cada vez que el menú del nodo pide renombrarlo. */
  renameSignal?: number
}

export type ChipFlowNode = Node<ChipNodeData, 'chip'>

export function ChipNode({ id, data, selected }: NodeProps<ChipFlowNode>) {
  if (data.fn) {
    return (
      <div
        className="vchip"
        data-type="function"
        data-selected={selected ? '' : undefined}
        title={`${data.fn.name}${data.fn.signature}: arrástrala a una llamada`}
      >
        <Icon name="function" size={12} className="vchip__icon" />
        <span className="vchip__name">{data.fn.name}</span>
        <span className="vchip__sig">{data.fn.signature}</span>
      </div>
    )
  }
  const chip = data.chip
  if (!chip) return null
  const type = valueTypeOf(chip.kind, chip.control)
  return (
    <div
      className="vchip"
      data-type={type}
      data-selected={selected ? '' : undefined}
      title={`${chip.label}: arrástrala a una casilla que reciba un valor`}
    >
      <Icon name={getKind(chip.kind).icon} size={12} className="vchip__icon" />
      <ChipName
        label={chip.label}
        signal={data.renameSignal ?? 0}
        renamable={(chip.renamable ?? false) && data.onRename !== undefined}
        onRename={(to) => {
          data.onRename?.(id, to)
        }}
      />
      <span className="vchip__eq">=</span>
      <ChipValue
        chip={chip}
        onChange={(next) => {
          data.onControlChange?.(id, next)
        }}
        editable={data.onControlChange !== undefined && (chip.editable?.includes('value') ?? true)}
      />
    </div>
  )
}

/** El nombre de un chip: con doble clic (o desde su menú) se renombra en todos los sitios donde se usa. */
function ChipName({
  label,
  signal,
  renamable,
  onRename,
}: {
  label: string
  signal: number
  renamable: boolean
  onRename: (to: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [seen, setSeen] = useState(signal)
  if (signal !== seen) {
    setSeen(signal)
    if (renamable) setEditing(true)
  }
  if (!editing) {
    return (
      <span
        className="vchip__name"
        {...(renamable
          ? {
              onDoubleClick: () => {
                setEditing(true)
              },
            }
          : {})}
      >
        {label}
      </span>
    )
  }
  return (
    <ChipRename
      label={label}
      onDone={(to) => {
        setEditing(false)
        if (to && to !== label) onRename(to)
      }}
    />
  )
}

function ChipRename({ label, onDone }: { label: string; onDone: (to: string | null) => void }) {
  const [draft, setDraft] = useState(label)
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    box.current?.focus()
    box.current?.select()
  }, [])
  return (
    <input
      ref={box}
      className="vchip__name vchip__value--input nodrag"
      aria-label={`Renombrar ${label}`}
      value={draft}
      style={{ width: `${Math.max(draft.length, 3) + 1}ch` }}
      onChange={(event) => {
        setDraft(event.target.value)
      }}
      onBlur={() => {
        onDone(draft.trim())
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onDone(draft.trim())
        } else if (event.key === 'Escape') onDone(null)
      }}
    />
  )
}

/** El valor de un chip, editable en su sitio: un número, un texto o un verdadero / falso. */
function ChipValue({
  chip,
  onChange,
  editable,
}: {
  chip: CanvasNode
  onChange: (next: ControlModel) => void
  editable: boolean
}) {
  const control = chip.control
  return control?.kind === 'boolean' ? (
    <button
      type="button"
      className="vchip__value vchip__value--switch nodrag"
      disabled={!editable}
      aria-pressed={control.value}
      onClick={() => {
        onChange({ ...control, value: !control.value })
      }}
    >
      {control.value ? 'True' : 'False'}
    </button>
  ) : control?.kind === 'number' ? (
    <ChipInput
      value={String(control.value)}
      editable={editable}
      label={`Valor de ${chip.label}`}
      onCommit={(text) => {
        const value = Number(text)
        if (text.trim() !== '' && Number.isFinite(value)) onChange({ ...control, value })
      }}
    />
  ) : control?.kind === 'text' ? (
    <ChipInput
      value={control.value}
      editable={editable}
      quoted
      label={`Valor de ${chip.label}`}
      onCommit={(value) => {
        onChange({ ...control, value })
      }}
    />
  ) : (
    <span className="vchip__value">{chipValue(chip)}</span>
  )
}

function ChipInput({
  value,
  onCommit,
  editable,
  label,
  quoted = false,
}: {
  value: string
  onCommit: (next: string) => void
  editable: boolean
  label: string
  quoted?: boolean
}) {
  const editor = useDraft(value, onCommit)
  const width = Math.min(Math.max(editor.shown.length, 2), 16) + 1
  return (
    <span className="vchip__field" data-quoted={quoted ? '' : undefined}>
      <input
        className="vchip__value vchip__value--input nodrag"
        aria-label={label}
        value={editor.shown}
        readOnly={!editable}
        style={{ width: `${width}ch` }}
        onChange={(event) => {
          editor.edit(event.target.value)
        }}
        onBlur={editor.commit}
        onKeyDown={onKeys(editor, false)}
      />
    </span>
  )
}

/**
 * La cajita de chips de un contexto: el fondo donde se agrupan y el botón de añadir. Los chips no
 * van dentro (son nodos del lienzo, para poder arrastrarlos): solo ocupan este sitio.
 */
export function TrayBox({
  tray,
  label,
  onAdd,
}: {
  tray: TrayLayout
  /** Para quién es: «Variables de suma». Lo lee un lector de pantalla. */
  label: string
  onAdd?: () => void
}) {
  return (
    <div className="tray" role="group" aria-label={label} style={{ width: tray.w, height: tray.h }}>
      {tray.add && (
        <button
          type="button"
          className="tray__add nodrag"
          data-label={tray.add.label ? '' : undefined}
          style={{ left: tray.add.x, top: tray.add.y, width: tray.add.w }}
          disabled={!onAdd}
          aria-label="Añadir una variable o constante"
          title="Añadir una variable o constante (se inicializa al principio)"
          onClick={(event) => {
            // El clic no llega al nodo que la lleva: seleccionaría el territorio y no lo que se acaba de crear.
            event.stopPropagation()
            onAdd?.()
          }}
        >
          <Icon name="plus" size={12} />
          {tray.add.label && <span>variable</span>}
        </button>
      )}
    </div>
  )
}

export interface TrayNodeData extends Record<string, unknown> {
  tray: TrayLayout
  label: string
  onAdd?: () => void
}

export type TrayFlowNode = Node<TrayNodeData, 'tray'>

/** La cajita del programa entero: un nodo propio, porque el programa no tiene territorio. */
export function TrayNode({ data }: NodeProps<TrayFlowNode>) {
  return (
    <TrayBox tray={data.tray} label={data.label} {...(data.onAdd ? { onAdd: data.onAdd } : {})} />
  )
}
