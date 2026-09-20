import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  buildShape,
  getKind,
  nodeSize,
  shapeFor,
  type Density,
  type FillMode,
  type Metrics,
  type NodeKindId,
  type NodeState,
  type Point,
} from '@prysel/morphology'
import { StatusChip, TypeBadge } from './Badge.tsx'
import { Control, type ControlModel } from './controls.tsx'
import { Icon } from './Icon.tsx'

/** Medio píxel de margen para que el trazo de 1px caiga nítido sobre la rejilla. */
const HAIRLINE = 0.75

/** Un puerto de entrada con nombre, ya medido: `y` es su altura dentro del nodo. */
export interface MeasuredSlot {
  id: string
  label: string
  y: number
}

export interface MorphNodeProps {
  kind: NodeKindId
  /** Nombre e intención del nodo. */
  label: string
  /** El fragmento de Python que representa — lo único monoespaciado del encabezado. */
  code?: string
  /** Metadata del pie: "428 → 91 filas · sales.py:42". */
  meta?: string
  density?: Density
  state?: NodeState
  /** Complejidad real (operaciones, elementos): el tamaño la refleja. */
  metrics?: Metrics
  /** El editor gráfico del cuerpo. Sin él, el nodo solo se lee. */
  control?: ControlModel
  onControlChange?: (next: ControlModel) => void
  /** `dead`: código inalcanzable. `generating`: la UI del nodo aún se está generando. */
  modifier?: 'dead' | 'generating'
  /** Enfocado por el usuario: gana elevación. */
  focused?: boolean
  /** `flat` desactiva desenfoque, sombras y animación (zoom lejano, lienzos grandes). */
  lod?: 'full' | 'flat'
  /** Tamaño explícito (contenedores). Sin él se deriva de tipo, densidad y complejidad. */
  size?: { w: number; h: number }
  showPorts?: boolean
  /** Acciones de la cabecera (duplicar, editar, plegar), como en un constructor de flujos. */
  showActions?: boolean
  /** Muestra el chip de estado («Inactivo», «Ejecutando»). Ocúltalo en un lienzo sin ejecución. */
  showStatus?: boolean
  /**
   * Campos que reciben su valor de otro nodo. Se marcan en el editor y el puerto se dibuja
   * a su altura: es lo que deja claro de dónde viene cada entrada.
   */
  linkedSlots?: string[]
  /** Avisa de dónde ha quedado cada puerto de entrada, para que el lienzo trace las conexiones. */
  onSlotsMeasured?: (slots: MeasuredSlot[]) => void
  onToggleDensity?: () => void
  /** Contenido de un contenedor Space. */
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

export function MorphNode({
  kind,
  label,
  code,
  meta,
  density = 'normal',
  state = 'dormant',
  metrics,
  control,
  onControlChange,
  modifier,
  focused = false,
  lod = 'full',
  size,
  showPorts = true,
  showActions = true,
  showStatus = true,
  linkedSlots,
  onSlotsMeasured,
  onToggleDensity,
  children,
  className,
  style,
}: MorphNodeProps) {
  const spec = getKind(kind)
  const { w, h } = size ?? nodeSize(spec, density, metrics)
  const geo = buildShape(shapeFor(spec, density), w, h)

  const compact = density === 'compact'
  const fill: FillMode = modifier === 'generating' ? 'hatch' : spec.fill
  // La sombra es atención: solo bajo un relleno opaco, y solo si algo la pide.
  const raised =
    !compact &&
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
    const found = [...root.querySelectorAll<HTMLElement>('[data-slot]')].map((el) => {
      const box = el.getBoundingClientRect()
      return {
        id: el.dataset['slot'] ?? '',
        label: el.dataset['slotLabel'] ?? el.dataset['slot'] ?? '',
        y: Math.round(box.top + box.height / 2 - base.top),
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

  return (
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
      data-density={density}
      data-lod={lod}
      data-modifier={modifier}
      data-raised={raised ? '' : undefined}
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
            <g key={i} transform={`translate(${(l.dx ?? 0) + HAIRLINE} ${(l.dy ?? 0) + HAIRLINE})`}>
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
          <div className="node__glance">
            <Icon name={spec.icon} size={14} className="node__glance-icon" />
            <span className="node__glance-label type-node-title">{label}</span>
            {onToggleDensity ? (
              <button
                type="button"
                className="node__action"
                aria-label="Entrar en el nodo"
                onClick={onToggleDensity}
              >
                <Icon name="chevron" size={13} />
              </button>
            ) : showStatus ? (
              <StatusChip state={state} showLabel={false} className="node__glance-state" />
            ) : null}
          </div>
        ) : (
          <>
            <header className="node__head">
              <TypeBadge family={spec.badge} icon={spec.icon} label={spec.name} />
              {showActions && (
                <div className="node__actions">
                  <button type="button" className="node__action" aria-label="Duplicar nodo">
                    <Icon name="copy" size={13} />
                  </button>
                  <button type="button" className="node__action" aria-label="Editar código">
                    <Icon name="pencil" size={13} />
                  </button>
                  {onToggleDensity && (
                    <button
                      type="button"
                      className="node__action"
                      aria-label={density === 'expanded' ? 'Plegar nodo' : 'Expandir nodo'}
                      aria-expanded={density === 'expanded'}
                      onClick={onToggleDensity}
                    >
                      <Icon name="chevron" size={13} />
                    </button>
                  )}
                </div>
              )}
            </header>

            <div className="node__body">
              <div className="node__title type-node-title">{label}</div>
              {showCode && <code className="node__code type-code">{code}</code>}
              {control && (
                <div className="node__control">
                  <Control
                    model={control}
                    level={level}
                    onChange={onControlChange}
                    {...(linkedSlots ? { linked: linkedSlots } : {})}
                  />
                </div>
              )}
              {children && <div className="node__children">{children}</div>}
            </div>

            {(meta || showStatus) && (
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
