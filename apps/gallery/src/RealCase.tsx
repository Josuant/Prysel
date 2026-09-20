import { useEffect, useMemo, useState } from 'react'
import type { Density, NodeState } from '@prysel/morphology'
import type { SemanticEdge } from '@prysel/spatial'
import { Segmented, type ControlModel } from '@prysel/ui'
import { Canvas, type CanvasNode } from './Canvas.tsx'

/**
 * Un caso real: un script de pandas, tal y como se vería en el lienzo.
 * El umbral es editable y todo lo que depende de él —el código, las ramas, el resultado—
 * se recalcula: manipular un nodo es reescribir el programa.
 *
 * Las posiciones no están escritas a mano: las decide la gramática espacial a partir del grafo.
 */

const SOURCE = (threshold: number) => `import pandas as pd

THRESHOLD = ${threshold}
sales    = pd.read_csv("data/sales.csv")
big      = sales[sales.amount > THRESHOLD]
descarte = sales[sales.amount <= THRESHOLD]
summary  = big.groupby("region").amount.sum()
display(summary)`

// ── Un conjunto de datos falso pero determinista, para que los números sean coherentes ──
const REGIONS = ['Norte', 'Sur', 'Este', 'Oeste']

const DATASET = (() => {
  let seed = 20260920
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  return Array.from({ length: 428 }, (_, i) => ({
    region: REGIONS[i % REGIONS.length] ?? 'Norte',
    amount: Math.round(60 + next() ** 2 * 3900),
    month: Math.floor(next() * 12),
  }))
})()

const euro = (n: number) => `${n.toLocaleString('es-ES')} €`

function summarize(threshold: number) {
  const big = DATASET.filter((r) => r.amount > threshold)
  const total = big.reduce((sum, r) => sum + r.amount, 0)
  const series = Array.from({ length: 12 }, (_, m) =>
    big.filter((r) => r.month === m).reduce((sum, r) => sum + r.amount, 0),
  )
  const byRegion = REGIONS.map((region) => ({
    region,
    total: big.filter((r) => r.region === region).reduce((sum, r) => sum + r.amount, 0),
  })).sort((a, b) => b.total - a.total)
  return { kept: big.length, dropped: DATASET.length - big.length, total, series, byRegion }
}

/** El orden de ejecución: lo usa la simulación. */
const ORDER = ['import', 'threshold', 'read', 'filter', 'group', 'discarded', 'display']

/**
 * Las relaciones del programa. `toPort` es lo que quita la ambigüedad:
 * dice exactamente qué campo del nodo destino alimenta cada conexión.
 */
const EDGES: SemanticEdge[] = [
  { from: 'import', to: 'read', relation: 'reference' },
  { from: 'read', to: 'filter', relation: 'transform', toPort: 'field' },
  { from: 'threshold', to: 'filter', relation: 'dependency', toPort: 'value' },
  { from: 'filter', to: 'group', relation: 'branch', label: 'verdadero' },
  { from: 'filter', to: 'discarded', relation: 'branch', label: 'falso', fromPort: 'alt' },
  { from: 'group', to: 'display', relation: 'transform' },
]

function program(threshold: number): CanvasNode[] {
  const { kept, dropped, total, series, byRegion } = summarize(threshold)
  return [
    {
      id: 'import',
      kind: 'external.import',
      label: 'pandas',
      code: 'import pandas as pd',
      meta: 'externo · 2.2.3',
      control: { kind: 'module', module: 'pandas', alias: 'pd' },
      density: 'compact',
    },
    {
      id: 'threshold',
      kind: 'value.number',
      label: 'THRESHOLD',
      code: `THRESHOLD = ${threshold}`,
      meta: 'int · sales.py:3',
      control: { kind: 'number', value: threshold, min: 0, max: 4000, step: 50, unit: '€' },
    },
    {
      id: 'read',
      kind: 'effect.io',
      label: 'Leer ventas',
      code: 'pd.read_csv("data/sales.csv")',
      meta: `disco · ${DATASET.length} filas`,
      control: {
        kind: 'io',
        target: 'data/sales.csv',
        mode: 'lectura',
        modes: ['lectura', 'escritura', 'añadir'],
      },
    },
    {
      id: 'filter',
      kind: 'control.condition',
      label: '¿Venta grande?',
      code: `sales[sales.amount > ${threshold}]`,
      meta: `${kept} de ${DATASET.length} filas pasan`,
      control: {
        kind: 'condition',
        field: 'sales.amount',
        operator: '>',
        value: 'THRESHOLD',
        operators: ['>', '>=', '<', '<=', '==', '!='],
        hits: [kept, dropped],
      },
    },
    {
      id: 'group',
      kind: 'transform.call',
      label: 'Sumar por región',
      code: 'big.groupby("region").amount.sum()',
      meta: `${kept} → ${byRegion.length} filas`,
      metrics: { ops: 3 },
      control: {
        kind: 'args',
        target: 'groupby',
        args: [
          { name: 'by', value: '"region"' },
          { name: 'columna', value: 'amount' },
          { name: 'agregación', value: 'sum' },
        ],
      },
    },
    {
      id: 'discarded',
      kind: 'value.number',
      label: 'descartadas',
      code: `len(descarte) = ${dropped}`,
      meta: 'int · rama falsa',
      control: { kind: 'number', value: dropped, min: 0, max: DATASET.length, step: 1 },
    },
    {
      id: 'display',
      kind: 'output.display',
      label: 'Ventas por región',
      code: 'display(summary)',
      meta: `${kept} ventas · umbral ${euro(threshold)}`,
      control: {
        kind: 'stats',
        metric: 'Importe total',
        value: euro(total),
        deltaPct: Math.round((kept / DATASET.length) * 1000) / 10,
        range: '12m',
        ranges: ['3m', '12m'],
        series: series.map((v) => v || 1),
        rows: byRegion.slice(0, 3).map((r) => ({ label: r.region, value: euro(r.total) })),
      },
      density: 'expanded',
    },
  ]
}

const params = new URLSearchParams(window.location.search)
const INITIAL_DENSITY = ((): Density => {
  const value = params.get('case')
  return value === 'compact' || value === 'expanded' ? value : 'normal'
})()

export function RealCase() {
  const [threshold, setThreshold] = useState(1000)
  const [density, setDensity] = useState<Density>(INITIAL_DENSITY)
  const [stage, setStage] = useState<number | null>(null)

  const nodes = useMemo(() => program(threshold), [threshold])
  const { kept } = summarize(threshold)

  useEffect(() => {
    if (stage === null || stage >= ORDER.length) return
    const timer = setTimeout(() => setStage(stage + 1), 620)
    return () => {
      clearTimeout(timer)
    }
  }, [stage])

  const stateOf = (id: string): NodeState => {
    if (stage === null) return 'dormant'
    const i = ORDER.indexOf(id)
    if (i < stage) return 'success'
    if (i === stage) return 'running'
    return 'dormant'
  }

  const running = stage !== null && stage < ORDER.length

  const onControlChange = (id: string, next: ControlModel) => {
    if (id === 'threshold' && next.kind === 'number') setThreshold(next.value)
  }

  return (
    <section className="mt-20">
      <h2 className="type-architecture">UN CASO REAL</h2>
      <p className="type-secondary mt-1 max-w-3xl text-ink-muted">
        Un script de pandas, tal y como se vería en el lienzo. Nada de esto está colocado a mano: la
        gramática espacial reconoce la decisión y la dibuja como un árbol. Mueve el deslizador de{' '}
        <strong className="text-ink">THRESHOLD</strong> y verás recalcularse el código, las dos
        ramas y el resultado; fíjate en que el campo <code className="type-code">THRESHOLD</code> de
        la condición está marcado, porque su valor llega por una conexión y no se escribe ahí.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented
          value={density}
          options={['compact', 'normal', 'expanded']}
          onChange={(v) => {
            setDensity(v as Density)
          }}
        />
        <button
          type="button"
          className="run-button type-field-label"
          onClick={() => {
            setStage(running ? null : 0)
          }}
        >
          {running ? 'Detener' : 'Ejecutar'}
        </button>
        <span className="type-tertiary text-ink-faint">
          Umbral {euro(threshold)} · {kept} de {DATASET.length} ventas
        </span>
      </div>

      <Canvas
        className="mt-4"
        nodes={nodes}
        edges={EDGES}
        density={density}
        stateOf={stateOf}
        onControlChange={onControlChange}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <h3 className="type-primary">El archivo que hay debajo</h3>
          <pre className="type-code mt-2 overflow-x-auto rounded-lg border border-border-card bg-surface p-4 text-ink-muted">
            {SOURCE(threshold)}
          </pre>
        </div>
        <div>
          <h3 className="type-primary">Qué demuestra</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {[
              'Las conexiones aterrizan en el campo concreto que alimentan: se ve que el umbral entra en el lado derecho de la comparación y los datos en el izquierdo.',
              'El layout no es genérico: al haber una decisión, la región se clasifica como árbol y las dos ramas se separan de verdad.',
              'En compacto el programa se lee como una frase; en expandido, cada nodo trae su editor completo.',
              'El estado recorre el grafo con chips e iconos, y las conexiones activas se encienden a su paso.',
            ].map((item) => (
              <li key={item} className="type-secondary text-ink-muted">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
