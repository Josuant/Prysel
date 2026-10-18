import { useState } from 'react'
import { sectionFlowFit, type IconId } from '@prysel/morphology'
import type { ModuleRole } from '@prysel/spatial'
import { Icon } from '../Icon.tsx'
import { RenameBox } from '../MorphNode.tsx'
import type { SectionGlyph, SectionInfo, Subprocess } from '../program.ts'

/**
 * Una **etapa**: una fase del algoritmo con nombre («Probar», «Juzgar», «Criar»).
 *
 * Plegada es una tarjeta que se lee sin abrirla: su número en el esquema, su título y su subtítulo; lo que
 * usa de antes → lo que deja para después (con su valor, si ya se ejecutó); y las pastillas de los
 * subprocesos a los que llama, con lo que esconde (un bucle, una decisión, algo que se enseña). Abierta es
 * un marco con esa misma cabecera y, dentro, el diagrama de flujo de siempre.
 */

/**
 * El estado de un módulo tras ejecutar el programa, dicho en una pestaña sobre su borde: `ran` (cuántas veces
 * se usó), `unused` (nadie lo usa), `idle` (no llegó a ejecutarse) o `failed` (ahí se paró).
 */
export interface ModuleState {
  tone: 'ran' | 'unused' | 'idle' | 'failed'
  label: string
  title: string
}

/** Las pastillas de los subprocesos: cada una abre la función, la clase o el método al que se llama. */
export function Subprocesses({
  opens,
  onOpen,
}: {
  opens: readonly Subprocess[]
  onOpen?: ((id: string) => void) | undefined
}) {
  if (opens.length === 0) return null
  return (
    <span className="subprocs">
      {opens.map((sub) => (
        <button
          key={sub.id}
          type="button"
          className="subproc nodrag"
          disabled={!onOpen}
          title={`Abrir ${sub.name}`}
          aria-label={`Abrir ${sub.name}`}
          onClick={(event) => {
            event.stopPropagation()
            onOpen?.(sub.id)
          }}
        >
          <Icon name="open" size={11} />
          <span className="subproc__name">{sub.name}</span>
        </button>
      ))}
    </span>
  )
}

const GLYPHS: Record<SectionGlyph, { icon: IconId; label: string }> = {
  loop: { icon: 'loop', label: 'Dentro repite algo' },
  branch: { icon: 'branch', label: 'Dentro decide algo' },
  output: { icon: 'globe', label: 'Dentro enseña o imprime algo' },
}

/** El papel de un módulo en la arquitectura: su icono y cómo se dice. */
const ROLES: Record<ModuleRole, { icon: IconId; label: string }> = {
  entrada: { icon: 'pencil', label: 'Entrada: recoge datos de quien lo usa' },
  datos: { icon: 'table', label: 'Datos: lo que el programa guarda' },
  logica: { icon: 'function', label: 'Lógica: calcula o transforma' },
  control: { icon: 'switch', label: 'Control: decide qué se hace y cuándo' },
  salida: { icon: 'globe', label: 'Salida: enseña el resultado' },
}

/** La insignia del papel: va junto al número de la etapa. */
function RoleBadge({ role }: { role?: ModuleRole | undefined }) {
  if (!role) return null
  return (
    <span className="section__role" data-role={role} title={ROLES[role].label}>
      <Icon name={ROLES[role].icon} size={12} />
    </span>
  )
}

/** El texto que se edita: el rótulo entero (título y subtítulo), como está en el comentario. */
const headingText = (info: SectionInfo) =>
  info.subtitle ? `${info.title}: ${info.subtitle}` : info.title

/** El título de una etapa: doble clic (o el menú) lo edita, y se escribe de vuelta en su comentario. */
function SectionTitle({
  info,
  signal,
  onRetitle,
}: {
  info: SectionInfo
  signal: number
  onRetitle?: ((text: string) => void) | undefined
}) {
  const [editing, setEditing] = useState(false)
  const [seen, setSeen] = useState(signal)
  // Un aviso nuevo del menú abre el cuadro: se compara durante el render, sin efectos.
  if (signal !== seen) {
    setSeen(signal)
    if (onRetitle) setEditing(true)
  }
  if (editing) {
    const text = headingText(info)
    return (
      <RenameBox
        label={text}
        onDone={(to) => {
          setEditing(false)
          if (to && to !== text) onRetitle?.(to)
        }}
      />
    )
  }
  return (
    <span
      className="section__title type-node-title"
      {...(onRetitle
        ? {
            title: 'Doble clic para renombrar la etapa',
            onDoubleClick: () => {
              setEditing(true)
            },
          }
        : {})}
    >
      {info.title}
    </span>
  )
}

function Toggle({
  info,
  open,
  onToggle,
}: {
  info: SectionInfo
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="node__action section__toggle nodrag"
      aria-label={open ? `Plegar la etapa ${info.title}` : `Abrir la etapa ${info.title}`}
      aria-expanded={open}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      <Icon name="chevron" size={13} />
    </button>
  )
}

export interface SectionCardProps {
  info: SectionInfo
  /** En la arquitectura: su papel. */
  role?: ModuleRole | undefined
  /** En la arquitectura: cuántos módulos usan lo que guarda (sus flechas salen al seleccionarlo). */
  usedBy?: number | undefined
  /** En la arquitectura: cómo le fue al ejecutar el programa (cuántas veces se usó, si nadie lo usa…). */
  state?: ModuleState | undefined
  /** Lo que dice el rótulo en sus demás líneas. */
  note?: string | undefined
  /** Solo con palabras: sin los nombres del código (en la arquitectura; el código queda a un gesto). */
  plain?: boolean | undefined
  size: { w: number; h: number }
  signal: number
  onToggle?: (() => void) | undefined
  onOpen?: ((id: string) => void) | undefined
  onRetitle?: ((text: string) => void) | undefined
}

/** La etapa plegada: se lee su fase sin abrirla. */
export function SectionCard({
  info,
  role,
  usedBy,
  state,
  note,
  plain,
  size,
  signal,
  onToggle,
  onOpen,
  onRetitle,
}: SectionCardProps) {
  const fit = plain
    ? { rows: 0, uses: 0, leaves: 0 }
    : sectionFlowFit(
        info.uses,
        info.leaves.map((leaf) => leaf.name),
        size.w,
      )
  const uses = info.uses.slice(0, fit.uses)
  const leaves = info.leaves.slice(0, fit.leaves)
  const usesChips = (
    <>
      {uses.map((name) => (
        <span
          key={name}
          className="section-chip"
          data-role="use"
          title={`Usa ${name}, que viene de antes`}
        >
          {name}
        </span>
      ))}
      {info.uses.length > uses.length && (
        <span className="section-chip__more">+{info.uses.length - uses.length}</span>
      )}
    </>
  )
  const leavesChips = (
    <>
      {leaves.map((leaf) => (
        <span
          key={leaf.name}
          className="section-chip"
          data-role="leave"
          data-changed={leaf.value?.changed ? '' : undefined}
          title={
            leaf.value ? `${leaf.name}: ${leaf.value.long}` : `Deja ${leaf.name} para lo que sigue`
          }
        >
          {leaf.name}
          {leaf.value?.short && <span className="section-chip__value">{leaf.value.short}</span>}
        </span>
      ))}
      {info.leaves.length > leaves.length && (
        <span className="section-chip__more">+{info.leaves.length - leaves.length}</span>
      )}
    </>
  )
  return (
    <div
      className="section-card"
      data-plain={plain ? '' : undefined}
      style={{ width: size.w, height: size.h }}
      role="group"
      aria-label={`Etapa ${info.ordinal}: ${info.title}`}
      // Como un nodo: alcanzable por teclado para recorrer el diagrama con un lector de pantalla.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      <header className="section-card__head">
        <span className="section__ordinal" aria-hidden>
          {info.ordinal}
        </span>
        <RoleBadge role={role} />
        <SectionTitle info={info} signal={signal} onRetitle={onRetitle} />
        {usedBy !== undefined && (
          <span
            className="section__shared"
            title={`Lo usan ${usedBy} módulos. Selecciónalo para ver cuáles.`}
          >
            lo usan {usedBy}
          </span>
        )}
        {onToggle && <Toggle info={info} open={false} onToggle={onToggle} />}
      </header>
      {state && (
        <span className="section__state" data-tone={state.tone} title={state.title}>
          {state.label}
        </span>
      )}
      {info.subtitle && (
        <p
          className="section-card__sub"
          title={note ? `${info.subtitle}\n\n${note}` : info.subtitle}
        >
          {info.subtitle}
        </p>
      )}
      {fit.rows === 1 && (
        <div className="section-card__flow">
          {usesChips}
          {uses.length > 0 && leaves.length > 0 && (
            <span className="section-card__arrow" aria-hidden>
              →
            </span>
          )}
          {leavesChips}
        </div>
      )}
      {fit.rows === 2 && (
        <>
          <div className="section-card__flow">{usesChips}</div>
          <div className="section-card__flow">
            <span className="section-card__arrow" aria-hidden>
              →
            </span>
            {leavesChips}
          </div>
        </>
      )}
      {!plain && info.opens.length + info.glyphs.length > 0 && (
        <div className="section-card__foot">
          <Subprocesses opens={info.opens} onOpen={onOpen} />
          {info.glyphs.map((glyph) => (
            <span key={glyph} className="section-glyph" title={GLYPHS[glyph].label}>
              <Icon name={GLYPHS[glyph].icon} size={12} />
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** La etapa abierta: un marco con su cabecera; dentro, sus sentencias. */
export function SectionFrame({
  info,
  role,
  note,
  size,
  signal,
  onToggle,
  onRetitle,
}: Omit<SectionCardProps, 'onOpen'>) {
  return (
    <div
      className="section-frame"
      style={{ width: size.w, height: size.h }}
      role="group"
      aria-label={`Etapa ${info.ordinal}: ${info.title}`}
    >
      <header className="section-frame__head">
        <span className="section__ordinal" aria-hidden>
          {info.ordinal}
        </span>
        <RoleBadge role={role} />
        <div className="section-frame__text">
          <SectionTitle info={info} signal={signal} onRetitle={onRetitle} />
          {info.subtitle && (
            <span
              className="section-frame__sub"
              title={note ? `${info.subtitle}\n\n${note}` : info.subtitle}
            >
              {info.subtitle}
            </span>
          )}
        </div>
        {onToggle && <Toggle info={info} open onToggle={onToggle} />}
      </header>
    </div>
  )
}
