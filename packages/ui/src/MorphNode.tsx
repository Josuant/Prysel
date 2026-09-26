import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  ACTION_TITLES,
  HEADER_EDITOR_KINDS,
  buildShape,
  getKind,
  nodeSize,
  shapeFor,
  territoryShape,
  type Density,
  type FillMode,
  type Metrics,
  type NodeKindId,
  type NodeState,
  type Point,
  type ValueType,
} from '@prysel/morphology'
import { StatusChip, TypeBadge } from './Badge.tsx'
import { Control, type ControlModel } from './controls.tsx'
import type { ChipSlot } from './chips.ts'
import type { StepInfo } from './steps.ts'
import { SlotStateContext, type SlotState } from './fields.tsx'
import { Icon } from './Icon.tsx'

/** Medio píxel de margen para que el trazo de 1px caiga nítido sobre la rejilla. */
const HAIRLINE = 0.75

/** Un puerto de entrada con nombre, ya medido: `y` es su altura dentro del nodo. */
export interface MeasuredSlot {
  id: string
  label: string
  y: number
}

/** Lo que el usuario le hace a un nodo desde su cabecera. El lienzo le pone el id y lo escribe en el código. */
export type NodeEdit =
  | { type: 'open-code' }
  | { type: 'delete' }
  | { type: 'duplicate' }
  /** `from`: cuál de los nombres de una asignación de varios (`a, b = f()`); sin él, el del nodo. */
  | { type: 'rename'; to: string; from?: string }

export interface MorphNodeProps {
  kind: NodeKindId
  /** Nombre e intención del nodo. */
  label: string
  /** El fragmento de Python que representa — lo único monoespaciado del encabezado. */
  code?: string
  /** Metadata del pie: "428 → 91 filas · sales.py:42". */
  meta?: string
  /** Lo que pide el usuario sobre el nodo: renombrarlo, plegarlo… Las demás acciones viven en su menú. */
  onAction?: (edit: NodeEdit) => void
  /** Sube cada vez que el menú del nodo pide renombrarlo: abre el cuadro del título. */
  renameSignal?: number
  /** El título es un nombre que Python conoce (una variable, una función): doble clic lo renombra. */
  renamable?: boolean
  /** Lo que el código dice de sí mismo (comentarios, docstring): bajo el título, o en la cabecera de un territorio. */
  note?: string
  density?: Density
  state?: NodeState
  /** Complejidad real (operaciones, elementos): el tamaño la refleja. */
  metrics?: Metrics
  /** El editor gráfico del cuerpo. Sin él, el nodo solo se lee. */
  control?: ControlModel
  /** Qué campos del editor se pueden reescribir (por camino). Sin lista, todos. */
  editable?: readonly string[]
  /** Nombres que se ofrecen al escribir en los campos que son expresiones. */
  suggestions?: readonly string[]
  onControlChange?: (next: ControlModel) => void
  /**
   * `dead`: código inalcanzable. `generating`: la UI del nodo aún se está generando. `pending`:
   * reproduciendo una lección, la ejecución aún no ha llegado aquí (construcción progresiva).
   */
  modifier?: 'dead' | 'generating' | 'pending'
  /** Enfocado por el usuario: gana elevación. */
  focused?: boolean
  /** `flat` desactiva desenfoque, sombras y animación (zoom lejano, lienzos grandes). */
  lod?: 'full' | 'flat'
  /** Tamaño explícito (contenedores). Sin él se deriva de tipo, densidad y complejidad. */
  size?: { w: number; h: number }
  showPorts?: boolean
  /** Muestra el chip de estado («Inactivo», «Ejecutando»). Ocúltalo en un lienzo sin ejecución. */
  showStatus?: boolean
  /**
   * El nodo se dibuja como **territorio**: los nodos que contiene van encima, sobre el lienzo,
   * no dentro de su cuerpo. Entonces solo enseña su cabecera — el contenido ya está a la vista,
   * y repetirlo en un editor sería decir dos veces lo mismo.
   */
  container?: boolean
  /**
   * Campos que reciben su valor de otro nodo. Se marcan en el editor y el puerto se dibuja
   * a su altura: es lo que deja claro de dónde viene cada entrada.
   */
  linkedSlots?: string[]
  /** Las casillas que llevan un chip dentro (una variable que se arrastró hasta ellas), por puerto. */
  chipSlots?: Readonly<Record<string, ChipSlot>>
  /**
   * La tarjeta se dibuja en **una sola línea** (operaciones y llamadas): icono, nombre, y la fórmula
   * o la llamada al lado. Solo en la tarjeta esbelta.
   */
  line?: boolean
  /**
   * Una decisión leída como diagrama de flujo: un **rombo** con la pregunta dentro (`¿ campo operador valor ?`),
   * sin cabecera, porque la forma ya dice que es una decisión.
   */
  diamond?: boolean
  /**
   * Lo que asigna la línea (`A = funcion()`, o `a, b = f()`): cada nombre es un chip que se arrastra a
   * una casilla.
   */
  results?: readonly {
    name: string
    type: ValueType
    hint?: string
    title?: string
    /** Reproduciendo una lección: este paso concreto lo acaba de escribir (un pulso, no solo aparecer). */
    changed?: boolean
  }[]
  /** Lo que se observó de cada paso de una cadena, para el editor de pasos. */
  steps?: readonly StepInfo[]
  /** El usuario agarra el chip de un resultado: el lienzo lleva el arrastre. */
  onGrabResult?: (event: React.PointerEvent<HTMLElement>, name: string) => void
  /** La casilla sobre la que está un chip que se arrastra, y si valdría soltarlo ahí. */
  hotSlot?: { slot: string; ok: boolean; convert?: boolean } | null
  /** Quita el chip de una casilla (la deja en un valor neutro). */
  onClearChip?: (slot: string) => void
  /** A quién se puede llamar (funciones del programa y de uso común): lo que ofrece el desplegable de una llamada. */
  callees?: readonly string[]
  /** Las casillas donde se usa el chip seleccionado. */
  litSlots?: readonly string[]
  /** Avisa de dónde ha quedado cada puerto de entrada, para que el lienzo trace las conexiones. */
  onSlotsMeasured?: (slots: MeasuredSlot[]) => void
  onToggleDensity?: () => void
  /** Qué hace el chevron, para lectores de pantalla: «Abrir la función», «Plegar suma». */
  toggleLabel?: string
  /** Contenido de un contenedor Space. */
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

/**
 * El título de un nodo. Si es un nombre que Python conoce, con doble clic se edita en su sitio y
 * al confirmar (Intro o salir) se renombra **en todos los sitios donde se usa**. Esc lo descarta.
 */
function Title({
  label,
  renamable,
  tag,
  signal = 0,
  onRename,
}: {
  label: string
  renamable: boolean
  tag: 'div' | 'span'
  /** Cada vez que sube, se abre el cuadro de renombrar (lo pide el menú del nodo). */
  signal?: number
  onRename: (to: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [seen, setSeen] = useState(signal)
  // Un aviso nuevo del menú abre el cuadro: se compara durante el render, sin efectos.
  if (signal !== seen) {
    setSeen(signal)
    if (renamable) setEditing(true)
  }
  const Tag = tag
  if (!editing) {
    return (
      <Tag
        className="node__title type-node-title"
        {...(renamable
          ? {
              title: 'Doble clic para renombrar',
              onDoubleClick: () => {
                setEditing(true)
              },
            }
          : {})}
      >
        {label}
      </Tag>
    )
  }
  return (
    <RenameBox
      label={label}
      onDone={(to) => {
        setEditing(false)
        if (to && to !== label) onRename(to)
      }}
    />
  )
}

/** El cuadro de renombrar. Selecciona el nombre entero **una sola vez**, al abrirse: escribir lo sustituye. */
function RenameBox({ label, onDone }: { label: string; onDone: (to: string | null) => void }) {
  const [draft, setDraft] = useState(label)
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    box.current?.focus()
    box.current?.select()
  }, [])
  return (
    <input
      ref={box}
      className="node__rename type-node-title nodrag"
      aria-label={`Renombrar ${label}`}
      value={draft}
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
        } else if (event.key === 'Escape') {
          onDone(null)
        }
      }}
    />
  )
}

/** El nombre que asigna una línea, como pastilla: se lleva hasta una casilla, y con doble clic se renombra. */
function ResultChip({
  name,
  type,
  hint,
  title,
  changed,
  renamable,
  signal,
  onRename,
  onGrab,
}: {
  name: string
  type: ValueType
  /** Lo que se observó al ejecutar (`200×2`): acompaña al nombre. */
  hint?: string
  /** Lo que dice al pasar el puntero, si se observó algo. */
  title?: string
  /** Reproduciendo una lección: este paso concreto lo acaba de escribir (un pulso, no solo aparecer). */
  changed?: boolean
  renamable: boolean
  signal: number
  onRename: (to: string) => void
  onGrab?: (event: React.PointerEvent<HTMLElement>) => void
}) {
  return (
    <span
      className="vchip vchip--result nodrag"
      data-type={type}
      {...(changed ? { 'data-changed': '' } : {})}
      title={
        title
          ? `${name}: ${title} — arrástrala a una casilla que reciba un valor`
          : `${name}: arrástrala a una casilla que reciba un valor`
      }
      onPointerDown={(event) => {
        // Escribir o seleccionar dentro del cuadro de renombrar no es llevarse el chip.
        if (event.target instanceof HTMLInputElement) return
        onGrab?.(event)
      }}
    >
      <Title label={name} renamable={renamable} tag="span" signal={signal} onRename={onRename} />
      {hint && <span className="vchip__hint">{hint}</span>}
    </span>
  )
}

/** De `def suma(a, b):` interesa lo que el título no dice: `(a, b)`. */
function signatureOf(code: string): string {
  return code.replace(/^\s*(?:async\s+)?(?:def|class)\s+\w+/, '').replace(/:\s*$/, '')
}

export function MorphNode({
  kind,
  label,
  code,
  meta,
  onAction,
  renameSignal = 0,
  renamable = false,
  note,
  density = 'normal',
  state = 'dormant',
  metrics,
  control,
  editable,
  suggestions,
  onControlChange,
  modifier,
  focused = false,
  lod = 'full',
  size,
  showPorts = true,
  showStatus = true,
  container = false,
  linkedSlots,
  chipSlots,
  line = false,
  diamond = false,
  results = [],
  steps,
  onGrabResult,
  hotSlot = null,
  onClearChip,
  callees,
  litSlots,
  onSlotsMeasured,
  onToggleDensity,
  toggleLabel,
  children,
  className,
  style,
}: MorphNodeProps) {
  const spec = getKind(kind)
  const { w, h } = size ?? nodeSize(spec, density, metrics)
  // Un ámbito es un territorio, no una píldora: conserva su pestaña de carpeta a cualquier densidad.
  const rhomb = diamond && !container
  const geo = buildShape(
    container ? territoryShape(spec) : rhomb ? 'diamond' : shapeFor(spec, density),
    w,
    h,
  )

  const compact = density === 'compact' && !container
  // Una tarjeta esbelta: solo lo relevante. El icono dice el tipo, el nombre va en la cabecera y el
  // pie (línea, estado) se pide con el tooltip o en expandido. Un territorio y expandido conservan todo.
  const slim = !container && !compact && density !== 'expanded'
  // Una operación o una llamada se leen de corrido: icono, nombre, y lo que hacen, en una sola línea.
  const lined =
    slim &&
    line &&
    (control?.kind === 'expression' || control?.kind === 'args' || control?.kind === 'assign')
  const lineTitle =
    control?.kind === 'args'
      ? ACTION_TITLES[control.target]
      : results.length > 0 || control?.kind === 'assign'
        ? undefined
        : label
  // Cada nombre que asigna la línea es una pastilla; con varios, se renombra cada uno por separado.
  const several = results.length > 1
  const resultChips = results.map((result) => (
    <ResultChip
      key={result.name}
      name={result.name}
      type={result.type}
      {...(result.hint ? { hint: result.hint } : {})}
      {...(result.title ? { title: result.title } : {})}
      {...(result.changed ? { changed: true } : {})}
      renamable={renamable || (several && onAction !== undefined)}
      signal={renameSignal}
      onRename={(to) =>
        onAction?.({ type: 'rename', to, ...(several ? { from: result.name } : {}) })
      }
      {...(onGrabResult ? { onGrab: (event) => onGrabResult(event, result.name) } : {})}
    />
  ))
  // Una decisión con su editor ya dice lo que compara: el título repetiría los mismos campos.
  const shownLabel =
    slim && kind === 'control.condition' && control?.kind === 'condition' ? 'Si' : label
  const fill: FillMode = modifier === 'generating' ? 'hatch' : spec.fill
  // La sombra es atención: solo bajo un relleno opaco, y solo si algo la pide.
  const raised =
    !compact &&
    !container &&
    spec.fill === 'solid' &&
    (spec.elevation === 'raised' || density === 'expanded' || focused)
  const band = geo.headerBand
  const level = density === 'expanded' ? 'full' : 'summary'
  // En normal el editor ya enseña el valor: repetir el código sería decir dos veces lo mismo.
  const showCode = code !== undefined && (density === 'expanded' || control === undefined)

  const contentRef = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState<MeasuredSlot[]>([])
  const previous = useRef('')

  // Los puertos no se declaran a mano: se miden donde el editor ha puesto cada campo.
  const measure = useCallback(() => {
    const root = contentRef.current
    if (!root) return
    const base = root.getBoundingClientRect()
    // El lienzo se acerca y se aleja con una transformación: lo que se mide en pantalla hay que
    // devolverlo a píxeles del nodo, o los puertos caerían a otra altura en cuanto hay zoom.
    const scale = root.offsetWidth > 0 ? base.width / root.offsetWidth : 1
    const found = [...root.querySelectorAll<HTMLElement>('[data-slot]')].map((el) => {
      const box = el.getBoundingClientRect()
      return {
        id: el.dataset['slot'] ?? '',
        label: el.dataset['slotLabel'] ?? el.dataset['slot'] ?? '',
        y: Math.round((box.top + box.height / 2 - base.top) / scale),
      }
    })
    const signature = JSON.stringify(found)
    if (signature === previous.current) return
    previous.current = signature
    setSlots(found)
    onSlotsMeasured?.(found)
  }, [onSlotsMeasured])

  useLayoutEffect(() => {
    measure()
    const root = contentRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => {
      observer.disconnect()
    }
  }, [measure, density, w, h, control])

  const connected = slots.filter((slot) => linkedSlots?.includes(slot.id))

  const rootStyle = {
    width: w,
    height: h,
    '--band': band === undefined ? undefined : `${band}px`,
    ...style,
  } as CSSProperties

  const slotState = useMemo<SlotState>(
    () => ({
      chips: chipSlots ?? {},
      hot: hotSlot,
      ...(onClearChip ? { clear: onClearChip } : {}),
      ...(callees ? { callees } : {}),
      ...(litSlots ? { lit: litSlots } : {}),
    }),
    [chipSlots, hotSlot, onClearChip, callees, litSlots],
  )

  return (
    <SlotStateContext.Provider value={slotState}>
      <div
        className={['node', className].filter(Boolean).join(' ')}
        style={rootStyle}
        role="group"
        aria-label={`${spec.name}: ${label}`}
        // El nodo es un grupo de solo lectura, pero se hace alcanzable por teclado
        // para que los lectores de pantalla puedan recorrer el diagrama nodo a nodo.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        data-kind={spec.id}
        data-role={spec.role}
        data-badge={spec.badge}
        data-stroke={spec.stroke}
        data-fill={fill}
        data-state={state}
        data-density={container ? 'normal' : density}
        data-slim={slim ? '' : undefined}
        data-line={lined ? '' : undefined}
        data-diamond={rhomb ? '' : undefined}
        data-lod={lod}
        data-modifier={modifier}
        data-raised={raised ? '' : undefined}
        data-container={container ? '' : undefined}
        data-band={band === undefined ? undefined : ''}
      >
        {raised && (
          <svg className="node__shadow" width={w} height={h} aria-hidden>
            <path d={geo.d} />
          </svg>
        )}

        <svg className="node__back" width={w} height={h} aria-hidden>
          {geo.layers
            .filter((l) => l.kind === 'back')
            .map((l, i) => (
              <g
                key={i}
                transform={`translate(${(l.dx ?? 0) + HAIRLINE} ${(l.dy ?? 0) + HAIRLINE})`}
              >
                <path className="node__back-plate" d={l.d} />
              </g>
            ))}
        </svg>

        <div className="node__fill" style={{ clipPath: `path('${geo.d}')` }} />

        <svg className="node__stroke" width={w} height={h} aria-hidden>
          <g transform={`translate(${HAIRLINE} ${HAIRLINE})`}>
            {geo.layers
              .filter((l) => l.kind === 'detail')
              .map((l, i) => (
                <path
                  key={i}
                  className="node__detail"
                  d={l.d}
                  transform={l.dx || l.dy ? `translate(${l.dx ?? 0} ${l.dy ?? 0})` : undefined}
                />
              ))}
            <path className="node__outline" d={geo.d} />
          </g>
        </svg>

        <div
          ref={contentRef}
          className="node__content"
          style={{
            padding: `${geo.inset.top}px ${geo.inset.right}px ${geo.inset.bottom}px ${geo.inset.left}px`,
          }}
        >
          {compact ? (
            <div className="node__glance" title={note}>
              <Icon name={spec.icon} size={14} className="node__glance-icon" />
              <span className="node__glance-label type-node-title">{label}</span>
              {onToggleDensity ? (
                <button
                  type="button"
                  className="node__action nodrag"
                  aria-label={toggleLabel ?? `Abrir ${label}`}
                  onClick={onToggleDensity}
                >
                  <Icon name="chevron" size={13} />
                </button>
              ) : showStatus ? (
                <StatusChip state={state} showLabel={false} className="node__glance-state" />
              ) : null}
            </div>
          ) : rhomb ? (
            <div className="node__diamond" {...(meta ? { title: meta } : {})}>
              <span className="node__ask" aria-hidden>
                ¿
              </span>
              {control ? (
                <div className="node__control">
                  <Control
                    model={control}
                    level="summary"
                    onChange={onControlChange}
                    {...(editable ? { editable } : {})}
                    {...(suggestions ? { suggestions } : {})}
                    {...(linkedSlots ? { linked: linkedSlots } : {})}
                  />
                </div>
              ) : (
                // Sin editor, la pregunta tal cual (la etiqueta ya viene como `¿…?`).
                <code className="node__code type-code">{label.replace(/^¿|\?$/g, '')}</code>
              )}
              <span className="node__ask" aria-hidden>
                ?
              </span>
              {showStatus && state !== 'dormant' && <StatusChip state={state} showLabel={false} />}
            </div>
          ) : lined && control ? (
            <>
              <div className="node__line" {...(meta ? { title: meta } : {})}>
                <TypeBadge family={spec.badge} icon={spec.icon} label={spec.name} iconOnly />
                {results.length > 0 && (
                  <>
                    {resultChips}
                    <span className="node__eq">=</span>
                  </>
                )}
                {lineTitle && (
                  <Title
                    label={lineTitle}
                    renamable={false}
                    tag="span"
                    onRename={() => undefined}
                  />
                )}
                <div className="node__control">
                  <Control
                    model={control}
                    level="summary"
                    line
                    onChange={onControlChange}
                    {...(editable ? { editable } : {})}
                    {...(suggestions ? { suggestions } : {})}
                    {...(linkedSlots ? { linked: linkedSlots } : {})}
                  />
                </div>
                {showStatus && state !== 'dormant' && (
                  <StatusChip state={state} showLabel={false} />
                )}
                {onToggleDensity && (
                  <button
                    type="button"
                    className="node__action nodrag"
                    aria-label={toggleLabel ?? 'Expandir nodo'}
                    onClick={onToggleDensity}
                  >
                    <Icon name="chevron" size={13} />
                  </button>
                )}
              </div>
              {note && (
                <p className="node__note" title={note}>
                  {note}
                </p>
              )}
            </>
          ) : (
            <>
              <header className="node__head" {...(slim && meta ? { title: meta } : {})}>
                <TypeBadge family={spec.badge} icon={spec.icon} label={spec.name} iconOnly={slim} />
                {/* Lo que asigna el nodo es una pastilla: se lleva a una casilla como cualquier chip. */}
                {slim && results.length > 0
                  ? resultChips
                  : (container || slim) && (
                      <Title
                        label={shownLabel}
                        renamable={renamable}
                        tag="span"
                        signal={renameSignal}
                        onRename={(to) => onAction?.({ type: 'rename', to })}
                      />
                    )}
                {container && code && kind === 'abstraction.collapsed' && (
                  <code className="node__signature type-code">{signatureOf(code)}</code>
                )}
                {/* El estado solo se enseña cuando pasa algo: en reposo no dice nada. */}
                {slim && showStatus && state !== 'dormant' && (
                  <StatusChip state={state} showLabel={false} />
                )}
                {/* Duplicar, editar como código y eliminar están en el menú del nodo (clic derecho). */}
                {onToggleDensity && (
                  <div className="node__actions">
                    <button
                      type="button"
                      className="node__action nodrag"
                      aria-label={
                        toggleLabel ??
                        (container
                          ? `Plegar ${label}`
                          : density === 'expanded'
                            ? 'Plegar nodo'
                            : 'Expandir nodo')
                      }
                      aria-expanded={container || density === 'expanded'}
                      onClick={onToggleDensity}
                    >
                      <Icon name="chevron" size={13} />
                    </button>
                  </div>
                )}
              </header>

              {container && note && (
                <p className="node__note node__note--doc" title={note}>
                  {note}
                </p>
              )}

              {/* El bucle es un territorio, pero lo que recorre y con qué variable se edita en su cabecera.
                  Lo mismo un `with`, un `except`, una clase, un `match` y cada `case`: la misma lista con la
                  que el reparto les deja sitio (`territoryHeadroom`), para que no se desalineen. */}
              {container && control && HEADER_EDITOR_KINDS.has(kind) && (
                <div className="node__control node__control--territory">
                  <Control
                    model={control}
                    level="summary"
                    onChange={onControlChange}
                    {...(editable ? { editable } : {})}
                    {...(suggestions ? { suggestions } : {})}
                    {...(linkedSlots ? { linked: linkedSlots } : {})}
                  />
                </div>
              )}

              {!container && (
                <div className="node__body">
                  {!slim && (
                    <Title
                      label={label}
                      renamable={renamable}
                      tag="div"
                      signal={renameSignal}
                      onRename={(to) => onAction?.({ type: 'rename', to })}
                    />
                  )}
                  {note && (
                    <p className="node__note" title={note}>
                      {note}
                    </p>
                  )}
                  {showCode && <code className="node__code type-code">{code}</code>}
                  {control && (
                    <div className="node__control">
                      <Control
                        model={control}
                        level={level}
                        {...(steps ? { steps } : {})}
                        onChange={onControlChange}
                        {...(editable ? { editable } : {})}
                        {...(suggestions ? { suggestions } : {})}
                        {...(linkedSlots ? { linked: linkedSlots } : {})}
                      />
                    </div>
                  )}
                  {children && <div className="node__children">{children}</div>}
                </div>
              )}

              {!container && !slim && (meta || showStatus) && (
                <footer className="node__foot">
                  {meta && <span className="node__meta type-field-label">{meta}</span>}
                  {showStatus && <StatusChip state={state} />}
                </footer>
              )}
            </>
          )}
        </div>

        {showPorts &&
          spec.ports.in &&
          // Con campos medidos, cada entrada tiene su propio puerto a la altura de su campo.
          (connected.length > 0 ? (
            connected.map((slot) => (
              <Port
                key={slot.id}
                at={{ x: 0, y: slot.y }}
                side="in"
                label={slot.label}
                linked={linkedSlots?.includes(slot.id) ?? false}
              />
            ))
          ) : (
            <Port at={geo.handles.in} side="in" />
          ))}
        {showPorts && spec.ports.out && <Port at={geo.handles.out} side="out" />}
        {showPorts && spec.ports.out && geo.handles.alt && <Port at={geo.handles.alt} side="alt" />}
      </div>
    </SlotStateContext.Provider>
  )
}

/** Puerto en reposo: casi invisible. Conectado, se vuelve sólido y dice a qué campo alimenta. */
function Port({
  at,
  side,
  label,
  linked = false,
}: {
  at: Point
  side: 'in' | 'out' | 'alt'
  label?: string
  linked?: boolean
}) {
  return (
    <span
      className="node__port"
      data-port={side}
      data-linked={linked ? '' : undefined}
      title={label}
      style={{ left: at.x, top: at.y }}
    />
  )
}
