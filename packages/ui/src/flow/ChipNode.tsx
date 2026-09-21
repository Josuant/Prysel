import { useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { getKind, valueTypeOf, type ControlModel, type IconId } from '@prysel/morphology'
import type { CanvasNode } from '../Canvas.tsx'
import { chipValue, type FunctionChip } from '../chips.ts'
import { Icon } from '../Icon.tsx'
import { Control } from '../controls.tsx'
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
  /** O la variable de iteración de un bucle. */
  iter?: { name: string; param?: boolean; icon?: IconId }
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
        <Handle
          type="source"
          id="note-out"
          position={Position.Right}
          isConnectable={false}
          className="note-handle"
        />
        <Icon name="function" size={12} className="vchip__icon" />
        <span className="vchip__name">{data.fn.name}</span>
        <span className="vchip__sig">{data.fn.signature}</span>
      </div>
    )
  }
  if (data.iter) {
    return (
      <div
        className="vchip"
        data-type={data.iter.param ? 'param' : 'iter'}
        data-selected={selected ? '' : undefined}
        title={
          data.iter.param
            ? `${data.iter.name}: lo que recibe la función; arrástrala a una casilla de dentro`
            : `${data.iter.name}: lo que toma el bucle en cada vuelta; arrástrala a una casilla de dentro`
        }
      >
        <Handle
          type="source"
          id="note-out"
          position={Position.Right}
          isConnectable={false}
          className="note-handle"
        />
        <Icon
          name={data.iter.param ? 'function' : (data.iter.icon ?? 'loop')}
          size={12}
          className="vchip__icon"
        />
        <span className="vchip__name">{data.iter.name}</span>
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
      <Handle
        type="source"
        id="note-out"
        position={Position.Right}
        isConnectable={false}
        className="note-handle"
      />
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
        editable={
          data.onControlChange !== undefined && (chip.editable?.includes(editedField(chip)) ?? true)
        }
      />
    </div>
  )
}

/** El campo que se escribe al editar el valor de un chip: el valor mismo, los elementos o las entradas. */
const editedField = (chip: CanvasNode): string =>
  chip.control?.kind === 'list'
    ? 'items'
    : chip.control?.kind === 'dict'
      ? 'entries'
      : chip.control?.kind === 'expression'
        ? 'left'
        : 'value'

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
  ) : control?.kind === 'list' || control?.kind === 'dict' || control?.kind === 'expression' ? (
    <ChipCollection chip={chip} control={control} onChange={onChange} editable={editable} />
  ) : (
    <span className="vchip__value">{chipValue(chip)}</span>
  )
}

/**
 * Una colección se ve resumida (`[1, 2, 3]`) y se edita en un panel bajo el chip, con el mismo
 * editor que tendría en un nodo: añadir y quitar elementos o claves, sin abrir nada más.
 */
function ChipCollection({
  chip,
  control,
  onChange,
  editable,
}: {
  chip: CanvasNode
  control: ControlModel
  onChange: (next: ControlModel) => void
  editable: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target
      if (root.current && target instanceof HTMLElement && !root.current.contains(target)) {
        setOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <span ref={root} className="vchip__collection">
      <button
        type="button"
        className="vchip__value vchip__value--switch nodrag"
        aria-expanded={open}
        aria-label={`Editar ${chip.label}`}
        onClick={() => {
          setOpen((current) => !current)
        }}
      >
        {chipValue(chip)}
      </button>
      {open && (
        <div
          className="vchip__pop nodrag nopan"
          role="dialog"
          aria-label={`Valor de ${chip.label}`}
        >
          <Control
            model={control}
            level="full"
            {...(editable ? { onChange } : {})}
            {...(chip.editable ? { editable: chip.editable } : {})}
          />
        </div>
      )}
    </span>
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
