import { useEffect, useState, type ReactNode } from 'react'
import { getKind, type Density, type NodeKindId, type NodeState } from '@prysel/morphology'
import { MorphNode, type ControlModel } from '@prysel/ui'
import { RealCase } from './RealCase.tsx'
import { SpatialGrammar } from './SpatialGrammar.tsx'
import { CHANNELS, GROUPS, SAMPLES } from './samples.tsx'

type Theme = 'light' | 'dark'
type Lod = 'full' | 'flat'

const DENSITIES: Density[] = ['compact', 'normal', 'expanded']
const STATES: NodeState[] = ['dormant', 'running', 'success', 'warning', 'error', 'selected']

const params = new URLSearchParams(window.location.search)

/** Lee un parámetro de la URL (`?theme=dark&density=compact&only=valores`): permite fotografiar una vista exacta. */
function fromUrl<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = params.get(name)
  return allowed.find((a) => a === value) ?? fallback
}

function initialTheme(): Theme {
  const fallback = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  return fromUrl('theme', ['light', 'dark'], fallback)
}

/** `?only=valores` muestra una sola sección (por título, sin acentos ni mayúsculas). */
const only = params.get('only')?.toLowerCase() ?? null
const show = (title: string) => only === null || title.toLowerCase().startsWith(only)

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [density, setDensity] = useState<Density>(fromUrl('density', DENSITIES, 'normal'))
  const [state, setState] = useState<NodeState>(fromUrl('state', STATES, 'dormant'))
  const [lod, setLod] = useState<Lod>(fromUrl<Lod>('lod', ['full', 'flat'], 'full'))
  const [grayscale, setGrayscale] = useState(params.get('gray') === '1')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <div className="min-h-screen bg-void text-ink">
      <header className="sticky top-0 z-10 border-b border-border-card bg-void/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <h1 className="type-architecture mr-auto">PRYSEL · LENGUAJE VISUAL</h1>
          <Segmented label="Tema" value={theme} options={['light', 'dark']} onChange={setTheme} />
          <Segmented label="Densidad" value={density} options={DENSITIES} onChange={setDensity} />
          <Segmented label="Estado" value={state} options={STATES} onChange={setState} />
          <Segmented label="Detalle" value={lod} options={['full', 'flat']} onChange={setLod} />
          <label className="type-secondary flex items-center gap-2">
            <input
              type="checkbox"
              checked={grayscale}
              onChange={(e) => {
                setGrayscale(e.target.checked)
              }}
            />
            Escala de grises
          </label>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 pb-24" data-grayscale={grayscale ? '' : undefined}>
        {show('cómo') && <Legend />}

        {GROUPS.filter((g) => show(g.title)).map((group) => (
          <section key={group.title} className="mt-14">
            <h2 className="type-architecture">{group.title.toUpperCase()}</h2>
            <p className="type-secondary mt-1 max-w-3xl text-ink-muted">{group.blurb}</p>
            <div className="mt-5 grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
              {group.kinds.map((id) => (
                <KindCard key={id} id={id} density={density} state={state} lod={lod} />
              ))}
            </div>
          </section>
        ))}

        {show('estado') && <StatesSection lod={lod} />}
        {show('densidad') && <DensitySection lod={lod} />}
        {show('gram') && <SpatialGrammar />}
        {show('un caso') && <RealCase />}
      </main>
    </div>
  )
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly T[]
  onChange: (v: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-2">
      <span className="type-tertiary text-ink-faint">{label}</span>
      <div className="flex overflow-hidden rounded-md border border-border-card bg-surface">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={o === value}
            onClick={() => {
              onChange(o)
            }}
            className={`type-field-label px-2.5 py-1 ${
              o === value ? 'bg-ink text-void' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  )
}

function Legend() {
  return (
    <section className="mt-10">
      <h2 className="type-architecture">CÓMO SE LEE EL LIENZO</h2>
      <p className="type-secondary mt-1 max-w-3xl text-ink-muted">
        Prysel no representa código: representa su comportamiento. Cada canal visual dice una sola
        cosa y ninguno depende solo del color — activa «Escala de grises» para comprobarlo.
      </p>
      <dl className="mt-4 grid gap-x-8 gap-y-3 [grid-template-columns:max-content_1fr]">
        {CHANNELS.map((c) => (
          <div key={c.name} className="contents">
            <dt className="type-primary">{c.name}</dt>
            <dd className="type-secondary text-ink-muted">
              <span className="text-ink">{c.says}.</span> {c.rule}.
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function Stage({ children, minHeight = 250 }: { children: ReactNode; minHeight?: number }) {
  return (
    <div
      className="stage relative flex items-center justify-center gap-8 rounded-lg border border-line-faint p-8"
      style={{ minHeight }}
    >
      {children}
    </div>
  )
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="type-field-label rounded-sm border border-border-card bg-surface px-1.5 py-0.5 text-ink-muted">
      {children}
    </span>
  )
}

/** Cada tarjeta guarda el estado de su propio editor: los controles son de verdad. */
function KindCard({
  id,
  density,
  state,
  lod,
}: {
  id: NodeKindId
  density: Density
  state: NodeState
  lod: Lod
}) {
  const spec = getKind(id)
  const sample = SAMPLES[id]
  const [control, setControl] = useState<ControlModel | undefined>(sample.control)
  const [open, setOpen] = useState(false)
  const effective: Density = open && density !== 'compact' ? 'expanded' : density

  return (
    <article className="flex flex-col gap-3">
      <Stage>
        {spec.fill === 'glass' && <HiddenInternals />}
        <MorphNode
          kind={id}
          label={sample.label}
          code={sample.code}
          meta={sample.meta}
          metrics={sample.metrics}
          control={control}
          onControlChange={setControl}
          density={effective}
          state={state}
          lod={lod}
          size={spec.role === 'container' ? { w: 300, h: 170 } : undefined}
          onToggleDensity={() => {
            setOpen((v) => !v)
          }}
        >
          {spec.role === 'container' && <ContainerContents id={id} lod={lod} />}
        </MorphNode>
      </Stage>
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="type-primary">{spec.name}</h3>
          <code className="type-code truncate text-ink-faint">{spec.python}</code>
        </div>
        <p className="type-secondary mt-1 text-ink-muted">{spec.why}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Tag>{spec.shape}</Tag>
          <Tag>{spec.stroke}</Tag>
          <Tag>{spec.fill}</Tag>
          {spec.control !== 'none' && <Tag>editor: {spec.control}</Tag>}
          {!spec.ports.in && <Tag>sin entrada</Tag>}
          {!spec.ports.out && <Tag>sin salida</Tag>}
        </div>
      </div>
    </article>
  )
}

/** Nodos dentro de un Space, para que el territorio contenga algo de verdad. */
function ContainerContents({ id, lod }: { id: NodeKindId; lod: Lod }) {
  const inside: Record<string, { kind: NodeKindId; label: string; at: [number, number] }[]> = {
    'space.for': [
      { kind: 'transform.operation', label: 'acumular', at: [0, 6] },
      { kind: 'value.number', label: 'total', at: [0, 52] },
    ],
    'space.if': [
      { kind: 'transform.call', label: 'vip', at: [0, 0] },
      { kind: 'transform.call', label: 'estándar', at: [0, 62] },
    ],
    'space.try': [
      { kind: 'effect.io', label: 'leer', at: [0, 0] },
      { kind: 'transform.call', label: 'reintentar', at: [0, 62] },
    ],
  }
  return (
    <>
      {(inside[id] ?? []).map((child) => (
        <MorphNode
          key={child.label}
          kind={child.kind}
          label={child.label}
          density="compact"
          showPorts={false}
          lod={lod}
          style={{ position: 'absolute', left: child.at[0], top: child.at[1] }}
        />
      ))}
    </>
  )
}

/** Lo que hay "dentro" de un nodo de vidrio: se ve difuminado a través, para que el efecto se entienda. */
function HiddenInternals() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="absolute left-[22%] top-[24%] h-10 w-28 rounded-md border border-line bg-surface" />
      <div className="absolute left-[52%] top-[54%] h-12 w-16 rounded-full border border-line bg-surface" />
      <div className="absolute left-[28%] top-[66%] h-8 w-36 rounded-md border border-line bg-void" />
      <div className="absolute left-[18%] top-[46%] h-[2px] w-[62%] bg-line" />
    </div>
  )
}

function SectionHeading({ title, blurb }: { title: string; blurb: string }) {
  return (
    <>
      <h2 className="type-architecture">{title}</h2>
      <p className="type-secondary mt-1 max-w-3xl text-ink-muted">{blurb}</p>
    </>
  )
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3">
      {children}
      <span className="type-field-label text-ink-faint">{label}</span>
    </div>
  )
}

function StatesSection({ lod }: { lod: Lod }) {
  const sample = SAMPLES['transform.call']
  return (
    <section className="mt-16">
      <SectionHeading
        title="ESTADO Y MODIFICADORES"
        blurb="El estado vive en un chip con icono propio, nunca en el relleno de la tarjeta. Tres modificadores cuentan otra cosa: código inalcanzable (se desvanece), interfaz generándose (rayado) y nodo enfocado (gana elevación)."
      />
      <div className="mt-4">
        <Stage minHeight={340}>
          <div className="flex flex-wrap items-start justify-center gap-x-8 gap-y-8">
            {STATES.map((s) => (
              <Labeled key={s} label={s}>
                <MorphNode
                  kind="transform.call"
                  label={sample.label}
                  code={sample.code}
                  meta={sample.meta}
                  state={s}
                  lod={lod}
                />
              </Labeled>
            ))}
            <Labeled label="dead">
              <MorphNode
                kind="transform.call"
                label={sample.label}
                code={sample.code}
                modifier="dead"
                lod={lod}
              />
            </Labeled>
            <Labeled label="generating">
              <MorphNode
                kind="smart.ui"
                label="Constructor de consulta"
                code="df.query(…)"
                modifier="generating"
                lod={lod}
              />
            </Labeled>
            <Labeled label="focused">
              <MorphNode
                kind="transform.call"
                label={sample.label}
                code={sample.code}
                focused
                lod={lod}
              />
            </Labeled>
          </div>
        </Stage>
      </div>
    </section>
  )
}

function DensitySection({ lod }: { lod: Lod }) {
  const picks: NodeKindId[] = ['value.number', 'data.dataframe', 'control.condition']
  return (
    <section className="mt-16">
      <SectionHeading
        title="DENSIDAD"
        blurb="La elige quien mira el lienzo. Compacto: una píldora para leer la lógica de un vistazo. Normal: el nodo con su editor resumido. Expandido: el editor completo, para manipular el programa sin escribir código."
      />
      <div className="mt-4 grid gap-5">
        {picks.map((id) => (
          <DensityRow key={id} id={id} lod={lod} />
        ))}
      </div>
    </section>
  )
}

function DensityRow({ id, lod }: { id: NodeKindId; lod: Lod }) {
  const sample = SAMPLES[id]
  const [control, setControl] = useState<ControlModel | undefined>(sample.control)
  return (
    <Stage minHeight={300}>
      <div className="flex flex-wrap items-end justify-center gap-x-10 gap-y-8">
        {DENSITIES.map((d) => (
          <Labeled key={d} label={`${getKind(id).name} · ${d}`}>
            <MorphNode
              kind={id}
              label={sample.label}
              code={sample.code}
              meta={sample.meta}
              metrics={sample.metrics}
              control={control}
              onControlChange={setControl}
              density={d}
              lod={lod}
            />
          </Labeled>
        ))}
      </div>
    </Stage>
  )
}
