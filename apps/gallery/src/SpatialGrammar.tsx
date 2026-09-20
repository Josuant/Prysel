import { useEffect, useMemo, useState } from 'react'
import type { NodeKindId, Role } from '@prysel/morphology'
import {
  STRATEGY_FOR,
  TOPOLOGY_RULES,
  analyze,
  generateProgram,
  layout,
  type Relation,
  type SemanticEdge,
  type Topology,
} from '@prysel/spatial'
import { Canvas, EdgeDefs, Icon, type CanvasNode } from '@prysel/ui'

/**
 * La quinta gramática: Prysel usa el espacio como lenguaje.
 * Cada ejemplo se dibuja con el mismo motor que el caso real; lo único que cambia
 * es el grafo, y por tanto la forma que la clasificación reconoce en él.
 */

const node = (id: string, kind: NodeKindId, label: string): CanvasNode => ({
  id,
  kind,
  label,
  density: 'compact',
})
const link = (from: string, to: string, extra: Partial<SemanticEdge> = {}): SemanticEdge => ({
  from,
  to,
  relation: 'transform',
  ...extra,
})

interface Example {
  topology: Topology
  caption: string
  nodes: CanvasNode[]
  edges: SemanticEdge[]
}

const EXAMPLES: Example[] = [
  {
    topology: 'pipeline',
    caption: 'leer → limpiar → guardar',
    nodes: [
      node('a', 'effect.io', 'leer'),
      node('b', 'transform.call', 'limpiar'),
      node('c', 'effect.io', 'guardar'),
    ],
    edges: [link('a', 'b'), link('b', 'c')],
  },
  {
    topology: 'branch',
    caption: 'if importe > 1000',
    nodes: [
      node('q', 'control.condition', '¿grande?'),
      node('t', 'transform.call', 'vip'),
      node('f', 'transform.call', 'estándar'),
    ],
    edges: [
      link('q', 't', { relation: 'branch', label: 'sí' }),
      link('q', 'f', { relation: 'branch', label: 'no', fromPort: 'alt' }),
    ],
  },
  {
    topology: 'loop',
    caption: 'for fila in ventas',
    nodes: [
      node('head', 'control.loop', 'cada fila'),
      node('b1', 'transform.operation', 'validar'),
      node('b2', 'transform.operation', 'acumular'),
    ],
    edges: [link('head', 'b1'), link('b1', 'b2'), link('b2', 'head', { relation: 'feedback' })],
  },
  {
    topology: 'aggregation',
    caption: 'concat([a, b, c])',
    nodes: [
      node('a', 'data.list', 'enero'),
      node('b', 'data.list', 'febrero'),
      node('c', 'data.list', 'marzo'),
      node('sum', 'transform.call', 'concatenar'),
    ],
    edges: [link('a', 'sum'), link('b', 'sum'), link('c', 'sum')],
  },
  {
    topology: 'fan-out',
    caption: 'un umbral usado por todo el programa',
    nodes: [
      node('src', 'value.number', 'UMBRAL'),
      node('a', 'control.condition', 'filtrar'),
      node('b', 'transform.call', 'avisar'),
      node('c', 'transform.call', 'registrar'),
    ],
    edges: [
      link('src', 'a', { relation: 'dependency' }),
      link('src', 'b', { relation: 'dependency' }),
      link('src', 'c', { relation: 'dependency' }),
    ],
  },
  {
    topology: 'comparison',
    caption: 'dos estrategias sobre el mismo dato',
    nodes: [
      node('src', 'data.dataframe', 'ventas'),
      node('x', 'transform.call', 'media'),
      node('y', 'transform.call', 'mediana'),
      node('out', 'output.display', 'comparar'),
    ],
    edges: [link('src', 'x'), link('src', 'y'), link('x', 'out'), link('y', 'out')],
  },
]

/** El vocabulario de conexiones, con su relación computacional. */
const RELATIONS: { relation: Relation; name: string; says: string }[] = [
  { relation: 'dependency', name: 'Dependencia', says: 'B usa el valor que produce A' },
  { relation: 'transform', name: 'Transformación', says: 'el dato entra y sale distinto' },
  { relation: 'branch', name: 'Rama', says: 'una de las salidas de una decisión, con su etiqueta' },
  { relation: 'merge', name: 'Confluencia', says: 'varias fuentes en un mismo destino' },
  { relation: 'feedback', name: 'Retorno', says: 'el control vuelve atrás y cierra un bucle' },
  { relation: 'reference', name: 'Referencia', says: 'se alude a algo sin que fluya un dato' },
]

export function SpatialGrammar() {
  return (
    <section className="mt-20">
      <h2 className="type-architecture">GRAMÁTICA ESPACIAL</h2>
      <p className="type-secondary mt-1 max-w-3xl text-ink-muted">
        La posición de un nodo no la decide un <code className="type-code">autoLayout()</code>{' '}
        genérico. El recorrido es: AST → grafo semántico → clasificación espacial → estrategia de
        layout → grafo visual. Prysel reconoce qué forma tiene un trozo de programa y la dibuja con
        la estrategia que le corresponde. Todos los ejemplos de abajo salen del mismo motor.
      </p>

      <div className="mt-6 grid gap-6 [grid-template-columns:repeat(auto-fill,minmax(400px,1fr))]">
        {EXAMPLES.map((example) => (
          <article key={example.topology} className="flex flex-col gap-3">
            <Canvas
              nodes={example.nodes}
              edges={example.edges}
              density="compact"
              gapX={72}
              gapY={26}
              minHeight={190}
            />
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="type-primary">{TOPOLOGY_RULES[example.topology].name}</h3>
                <code className="type-code text-ink-faint">
                  {example.topology} → {STRATEGY_FOR[example.topology]}
                </code>
              </div>
              <p className="type-tertiary mt-0.5 text-ink-faint">{example.caption}</p>
              <p className="type-secondary mt-1 text-ink-muted">
                {TOPOLOGY_RULES[example.topology].why}
              </p>
            </div>
          </article>
        ))}
      </div>

      <ConnectionGrammar />
      <DepthDemo />
      <DensityCheck />
    </section>
  )
}

function ConnectionGrammar() {
  return (
    <div className="mt-14">
      <h3 className="type-architecture">GRAMÁTICA DE CONEXIONES</h3>
      <p className="type-secondary mt-1 max-w-3xl text-ink-muted">
        Una conexión no es una línea que une dos cajas: es una relación computacional, y de ella se
        derivan el grosor, la punta y la curvatura. El color queda libre para el estado.
      </p>
      <dl className="mt-4 grid gap-x-8 gap-y-3 [grid-template-columns:max-content_max-content_1fr]">
        {RELATIONS.map((item) => (
          <div key={item.relation} className="contents">
            <dt className="type-primary">{item.name}</dt>
            <dd>
              <RelationSample relation={item.relation} />
            </dd>
            <dd className="type-secondary text-ink-muted">{item.says}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * Un trozo de conexión de muestra. `branch` y `merge` comparten el trazo de una dependencia
 * a propósito: lo que las distingue es la topología (una etiqueta, una confluencia), no el estilo.
 */
function RelationSample({ relation }: { relation: Relation }) {
  const weight = relation === 'transform' ? 'thick' : 'thin'
  const arrow = `url(#prysel-arrow-${weight})`
  const line = (d: string) => <path className="edge__line" d={d} markerEnd={arrow} />

  return (
    <svg width={122} height={34} className="edge-sample" aria-hidden>
      <EdgeDefs />
      <g className="edge" data-relation={relation}>
        {relation === 'feedback' && line('M112 10C86 44 34 44 8 10')}
        {relation === 'merge' && (
          <>
            <path className="edge__line" d="M6 6C40 6 44 17 74 17" />
            <path className="edge__line" d="M6 28C40 28 44 17 74 17" />
            {line('M70 17H112')}
          </>
        )}
        {relation === 'branch' && (
          <>
            {line('M6 17H112')}
            <rect className="edge__label-bg" x={44} y={8} width={30} height={18} rx={9} />
            <text className="edge__label type-badge" x={59} y={21} textAnchor="middle">
              sí
            </text>
          </>
        )}
        {(relation === 'dependency' || relation === 'transform' || relation === 'reference') &&
          line('M6 17H112')}
      </g>
    </svg>
  )
}

// ── Profundidad ──────────────────────────────────────────────────────────────

interface Level {
  id: string
  title: string
  summary: string
  nodes: CanvasNode[]
  edges: SemanticEdge[]
  /** Qué nodo de este nivel se puede abrir, y a qué nivel lleva. */
  opens?: { node: string; into: string }
}

const LEVELS: Record<string, Level> = {
  root: {
    id: 'root',
    title: 'Customer pipeline',
    summary: 'El programa entero: tres pasos.',
    nodes: [
      node('load', 'effect.io', 'cargar'),
      {
        ...node('normalize', 'abstraction.collapsed', 'normalizar'),
        metrics: { ops: 47 },
        openable: true,
      },
      node('save', 'effect.io', 'guardar'),
    ],
    edges: [link('load', 'normalize'), link('normalize', 'save')],
    opens: { node: 'normalize', into: 'normalize' },
  },
  normalize: {
    id: 'normalize',
    title: 'normalize()',
    summary: 'Lo que había detrás del nodo: tres funciones.',
    nodes: [
      node('clean', 'transform.call', 'limpiar'),
      {
        ...node('validate', 'abstraction.collapsed', 'validar'),
        metrics: { ops: 12 },
        openable: true,
      },
      node('enrich', 'transform.call', 'enriquecer'),
    ],
    edges: [link('clean', 'validate'), link('validate', 'enrich')],
    opens: { node: 'validate', into: 'validate' },
  },
  validate: {
    id: 'validate',
    title: 'validate()',
    summary: 'El fondo: las operaciones concretas.',
    nodes: [
      node('nulls', 'control.condition', '¿nulos?'),
      node('types', 'transform.operation', 'tipos'),
      node('raise', 'control.raise', 'error'),
    ],
    edges: [
      link('nulls', 'types', { relation: 'branch', label: 'no' }),
      link('nulls', 'raise', { relation: 'branch', label: 'sí', fromPort: 'alt' }),
    ],
  },
}

/**
 * Profundidad = nivel de abstracción. No es un efecto 3D: al entrar en un nodo, el nivel
 * anterior se queda detrás desenfocado, que es exactamente lo que significa el relleno de vidrio.
 */
export function DepthDemo() {
  const [path, setPath] = useState<string[]>(['root'])
  /** El nivel que se está yendo, mientras dura el viaje. */
  const [leaving, setLeaving] = useState<{ id: string; direction: 'in' | 'out' } | null>(null)

  const currentId = path[path.length - 1] ?? 'root'
  const level = LEVELS[currentId] ?? LEVELS['root']

  const travel = (next: string[], direction: 'in' | 'out') => {
    const from = path[path.length - 1]
    if (!from || next[next.length - 1] === from) return
    setLeaving({ id: from, direction })
    setPath(next)
  }

  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => {
      setLeaving(null)
    }, 460)
    return () => {
      clearTimeout(timer)
    }
  }, [leaving])

  if (!level) return null

  return (
    <div className="mt-14">
      <h3 className="type-architecture">PROFUNDIDAD = ABSTRACCIÓN</h3>
      <p className="type-secondary mt-1 max-w-3xl text-ink-muted">
        La tercera dimensión no es decoración: es el nivel de abstracción. Entrar en un nodo no abre
        un panel — atraviesas una capa. El nivel que dejas atrás retrocede de verdad en el eje Z y
        se desenfoca, que es justo lo que significa el relleno de vidrio en la gramática de nodos.
      </p>

      <nav className="mt-4 flex flex-wrap items-center gap-1" aria-label="Ruta de abstracción">
        {path.map((id, i) => (
          <span key={id} className="flex items-center gap-1">
            {i > 0 && <Icon name="chevron" size={12} className="-rotate-90 text-ink-faint" />}
            <button
              type="button"
              className="type-field-label rounded-md px-2 py-1 text-ink-muted hover:bg-surface hover:text-ink"
              aria-current={i === path.length - 1 ? 'page' : undefined}
              onClick={() => {
                travel(path.slice(0, i + 1), 'out')
              }}
            >
              {LEVELS[id]?.title ?? id}
            </button>
          </span>
        ))}
        <span className="type-tertiary ml-2 text-ink-faint">
          nivel {path.length - 1} · {level.summary}
        </span>
      </nav>

      <div className="depth mt-3">
        {leaving && (
          <div className="depth__layer" data-leaving={leaving.direction} aria-hidden>
            <DepthLevel level={LEVELS[leaving.id]} />
          </div>
        )}
        <div
          className="depth__layer"
          key={currentId}
          data-entering={leaving?.direction ?? undefined}
        >
          <DepthLevel
            level={level}
            onEnter={(id) => {
              if (id === level.opens?.node) travel([...path, level.opens.into], 'in')
            }}
          />
        </div>
      </div>
      {level.opens && (
        <p className="type-tertiary mt-2 text-ink-faint">
          Abre «{level.nodes.find((n) => n.id === level.opens?.node)?.label}» con su chevron para
          atravesar una capa.
        </p>
      )}
    </div>
  )
}

function DepthLevel({ level, onEnter }: { level?: Level; onEnter?: (id: string) => void }) {
  if (!level) return null
  return (
    <Canvas
      nodes={level.nodes}
      edges={level.edges}
      density="compact"
      gapX={80}
      gapY={26}
      minHeight={140}
      {...(level.opens && onEnter ? { onEnter } : {})}
    />
  )
}

// ── Densidad ─────────────────────────────────────────────────────────────────

/** Del rol semántico al tipo de nodo, para poder dibujar un programa generado. */
const KIND_FOR: Record<Role, NodeKindId> = {
  value: 'value.number',
  data: 'data.dataframe',
  transform: 'transform.call',
  control: 'control.condition',
  effect: 'effect.io',
  output: 'output.display',
  external: 'external.import',
  abstraction: 'abstraction.collapsed',
  opaque: 'opaque.code',
  container: 'space.for',
}

const STEPS = 20

/**
 * La prueba de densidad. El programa está generado, no dibujado a mano, y se mide con las
 * mismas métricas que los tests: es la respuesta honesta a «¿esto se entiende cuando crece?».
 */
function DensityCheck() {
  const { nodes, edges, metrics } = useMemo(() => {
    const graph = generateProgram({ steps: STEPS })
    const measured = analyze(graph, layout(graph))
    return {
      nodes: graph.nodes.map((n) => ({
        id: n.id,
        kind: KIND_FOR[n.role] ?? 'transform.call',
        label: n.id.replace(':', ' '),
        density: 'compact' as const,
      })),
      edges: graph.edges,
      metrics: measured,
    }
  }, [])

  return (
    <div className="mt-14">
      <h3 className="type-architecture">LA PRUEBA DE DENSIDAD</h3>
      <p className="type-secondary mt-1 max-w-3xl text-ink-muted">
        Un programa de {STEPS} pasos, generado y colocado por el mismo motor. Estructuralmente
        aguanta: ningún nodo se pisa, ninguna conexión va hacia atrás y los cruces por conexión
        bajan al crecer. Pero el lienzo solo crece a lo ancho, así que al encajarlo en una pantalla
        cada nodo queda a <strong className="text-ink">{metrics.nodeWidthAtFit} px</strong> — por
        debajo de los ~90 px que hacen falta para leer uno. Ésta es la deuda pendiente antes de
        conectar un parser de Python.
      </p>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1">
        {[
          ['nodos', String(metrics.nodes)],
          ['conexiones', String(metrics.edges)],
          ['solapes', String(metrics.overlaps)],
          ['cruces/conexión', metrics.crossingsPerEdge.toFixed(2)],
          ['proporción', `${metrics.aspect.toFixed(1)}:1`],
        ].map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <dt className="type-tertiary text-ink-faint">{label}</dt>
            <dd className="type-value text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <Canvas className="mt-3" nodes={nodes} edges={edges} density="compact" minHeight={220} />
    </div>
  )
}
