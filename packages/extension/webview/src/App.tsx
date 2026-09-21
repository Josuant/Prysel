import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Density, NodeState } from '@prysel/morphology'
import type { Program } from '@prysel/python'
import type { SemanticEdge } from '@prysel/spatial'
import {
  AddNodeMenu,
  Canvas,
  type CanvasNode,
  type NodeMenuItem,
  FunctionMenu,
  addPlace,
  toCanvasNodes,
  useProgramView,
} from '@prysel/ui'
import { actionEdits } from '@prysel/python/edits'
import type { NodeAction, TemplateId } from '@prysel/morphology'
import { parseWebviewMessage, type Theme } from '../../src/protocol.ts'
import { topLevelOf } from '../../src/plan.ts'
import {
  chipHint,
  describeSummary,
  runCaption,
  type Assets,
  type KernelStatus,
  type RunState,
  type RunView,
} from '../../src/runs.ts'
import { OutputPanel } from './OutputPanel.tsx'
import {
  FIGURE,
  contentOf,
  pinNodeId,
  resolvePins,
  sameKey,
  togglePin,
  viewableOf,
  type PinKey,
} from './pins.ts'
import { useWriteBack } from './useWriteBack.ts'

const vscode = acquireVsCodeApi()
const post = (message: unknown) => {
  vscode.postMessage(message)
}

const DENSITIES: Density[] = ['compact', 'normal', 'expanded']
const DENSITY_LABELS: Record<Density, string> = {
  compact: 'Compacto',
  normal: 'Normal',
  expanded: 'Expandido',
}

interface SavedState {
  density?: Density
  /** Los visores fijados, por archivo: viven en el lienzo, no en el código. */
  pins?: Record<string, PinKey[]>
}

const NO_EDGES: SemanticEdge[] = []
const NO_RUNS: Record<string, RunView> = {}

/** El estado visual de un nodo según cómo está su sentencia: al día, desactualizada, ejecutándose o con error. */
const NODE_STATE: Record<RunState, NodeState> = {
  never: 'dormant',
  running: 'running',
  fresh: 'success',
  stale: 'stale',
  error: 'error',
}

const KERNEL_LABEL: Record<KernelStatus, string> = {
  stopped: 'Motor parado',
  starting: 'Arrancando el motor…',
  idle: 'Motor listo',
  busy: 'Ejecutando…',
  dead: 'Motor caído',
}

export function App() {
  const [program, setProgram] = useState<Program | null>(null)
  const [file, setFile] = useState<string | null>(null)
  /** La versión del texto que se está enseñando: los resultados solo valen para ella. */
  const [version, setVersion] = useState<number | null>(null)
  const [runs, setRuns] = useState<Record<string, RunView>>(NO_RUNS)
  const [kernel, setKernel] = useState<KernelStatus>('stopped')
  const [problem, setProblem] = useState<string | null>(null)
  const [assets, setAssets] = useState<ReadonlyMap<number, Assets>>(new Map())
  const [outputOpen, setOutputOpen] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  // Lo que se acaba de crear queda enfocado: se localiza por la línea en la que se escribió.
  const focusCreated = useCallback((created: Program, line: number) => {
    const node = created.nodes.find((n) => n.line === line)
    if (node) setSelected(node.id)
  }, [])
  const { pending, change: changeControl, submit, received } = useWriteBack(post, focusCreated)
  const [theme, setTheme] = useState<Theme>('dark')
  const [density, setDensity] = useState<Density>(() => {
    const saved = vscode.getState() as SavedState | undefined
    return saved?.density ?? 'normal'
  })

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = parseWebviewMessage(event.data)
      if (!message) return
      if (message.type === 'update') {
        setProgram(message.program)
        setFile(message.file ?? null)
        setVersion(message.version ?? null)
        received(message.program, message.version ?? null)
      } else if (message.type === 'runs') {
        setRuns(message.views)
        setKernel(message.kernel)
        setProblem(message.problem)
      } else if (message.type === 'assets') {
        setAssets((previous) => new Map(previous).set(message.seq, message.assets))
      } else if (message.type === 'theme') {
        setTheme(message.theme)
      }
    }
    window.addEventListener('message', onMessage)
    vscode.postMessage({ type: 'ready' })
    return () => {
      window.removeEventListener('message', onMessage)
    }
  }, [received])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const [allPins, setAllPins] = useState<Record<string, PinKey[]>>(
    () => (vscode.getState() as SavedState | undefined)?.pins ?? {},
  )
  const pins = useMemo(() => allPins[file ?? ''] ?? [], [allPins, file])
  const remember = (nextDensity: Density, nextPins: Record<string, PinKey[]>) => {
    vscode.setState({ density: nextDensity, pins: nextPins } satisfies SavedState)
  }
  const changeDensity = (next: Density) => {
    setDensity(next)
    remember(next, allPins)
  }
  /** Fija el valor de una sentencia en un visor del lienzo, o lo quita si ya estaba. */
  const pin = (key: PinKey) => {
    const next = { ...allPins, [file ?? '']: togglePin(pins, key) }
    setAllPins(next)
    remember(density, next)
  }

  /** A qué sentencia de primer nivel pertenece cada nodo: es la unidad que se ejecuta. */
  const top = useMemo(() => (program ? topLevelOf(program) : new Map<string, string>()), [program])

  const source = useMemo(() => {
    if (!program) return []
    return toCanvasNodes(program.nodes).map((node) => {
      const shown = pending[node.id] ? { ...node, control: pending[node.id] } : node
      // Solo la propia sentencia lleva lo observado: sus nodos de dentro no definen nombres del programa.
      const view = top.get(node.id) === node.id ? runs[node.id] : undefined
      if (!view) return shown
      const caption = runCaption(view)
      const observed = Object.fromEntries(
        Object.entries(view.values ?? {}).map(([name, summary]) => {
          const short = chipHint(summary)
          return [name, { ...(short ? { short } : {}), long: describeSummary(summary) }]
        }),
      )
      return {
        ...shown,
        ...(caption ? { meta: `línea ${node.line} · ${caption}` } : {}),
        ...(Object.keys(observed).length > 0 ? { observed } : {}),
      }
    })
  }, [program, pending, runs, top])

  const viewOf = (id: string): RunView | undefined => {
    const statement = top.get(id)
    return statement === undefined ? undefined : runs[statement]
  }
  const stateOf = (id: string): NodeState => {
    const view = viewOf(id)
    return view ? NODE_STATE[view.state] : 'dormant'
  }
  const started = kernel !== 'stopped' || Object.values(runs).some((r) => r.state !== 'never')

  /** Ejecutar: los nodos pedidos (con lo que necesitan y no está al día), o todo. */
  const run = (ids: string[] | 'all') => {
    if (version === null) return
    post({ type: 'run', version, ids })
  }
  const selectedView = selected === null ? undefined : viewOf(selected)
  const statementNode = program?.nodes.find(
    (n) => n.id === (selected === null ? undefined : top.get(selected)),
  )

  // Mayús+Intro ejecuta el nodo seleccionado, como en un notebook (salvo escribiendo en un campo).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !event.shiftKey || selected === null) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable]')
      ) {
        return
      }
      event.preventDefault()
      if (version !== null) post({ type: 'run', version, ids: [selected] })
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [selected, version])

  // Un fallo lleva la atención a su nodo: es lo que hay que mirar.
  const failed = useMemo(
    () => Object.entries(runs).find(([, view]) => view.state === 'error')?.[0] ?? null,
    [runs],
  )
  const [lastFailed, setLastFailed] = useState<string | null>(null)
  // Se ajusta al recibir el fallo, no en un efecto: el mismo fallo no vuelve a robar la selección.
  if (failed !== lastFailed) {
    setLastFailed(failed)
    if (failed !== null) {
      setSelected(failed)
      setOutputOpen(true)
    }
  }

  // El programa enseña cada función una vez (como su llamada); una función se ve aparte.
  // Compacto pliega las funciones (vista de pájaro); normal y expandido las abren.
  const view = useProgramView(source, program?.edges ?? NO_EDGES, density)
  const unsupported = program?.unsupported ?? []
  /** Los visores fijados: ventanas con el valor que dejó su sentencia, colgando de ella. */
  const viewers = useMemo(() => {
    const visible = new Set(view.nodes.map((node) => node.id))
    const nodes: CanvasNode[] = []
    const links: SemanticEdge[] = []
    for (const resolved of resolvePins(pins, runs)) {
      if (!visible.has(resolved.statement)) continue
      const assetsOf = resolved.view.seq === undefined ? undefined : assets.get(resolved.view.seq)
      const content = contentOf(resolved.key, resolved.view, assetsOf)
      const id = pinNodeId(resolved.key)
      nodes.push({ id, kind: 'output.display', label: content.title, viewer: content })
      links.push({ from: resolved.statement, to: id, relation: 'transform' })
    }
    return { nodes, links }
  }, [pins, runs, assets, view.nodes])
  const canvasNodes = useMemo(() => [...view.nodes, ...viewers.nodes], [view.nodes, viewers.nodes])
  const canvasEdges = useMemo(() => [...view.edges, ...viewers.links], [view.edges, viewers.links])
  /** Lo que ofrece el menú de un nodo ejecutado: ver cada uno de sus valores en un visor. */
  const viewerMenu = (id: string): NodeMenuItem[] => {
    const stmt = runs[id]
    if (top.get(id) !== id || !stmt || stmt.state === 'never') return []
    const names = viewableOf(stmt, stmt.seq === undefined ? undefined : assets.get(stmt.seq))
    return names.slice(0, 6).map((name) => {
      const key: PinKey = { id, hash: stmt.hash, name }
      const shown = name.startsWith(FIGURE) ? 'la figura' : '«' + name + '»'
      const on = pins.some((p) => sameKey(p, key))
      return {
        label: on ? 'Quitar el visor de ' + shown : 'Ver ' + shown + ' en un visor',
        onSelect: () => {
          pin(key)
        },
      }
    })
  }

  /** Lo que el usuario le hace a un nodo, o añade: se traduce a ediciones de texto y se escribe en el archivo. */
  const act = (action: NodeAction) => {
    if (action.type === 'delete' && action.id === selected) setSelected(null)
    submit((current) => actionEdits(current, action))
  }
  /** Dónde va lo que se añade: dentro del territorio seleccionado, tras otro nodo, o al final de lo que se ve. */
  const { where: addWhere, place } = addPlace(
    program?.nodes.find((n) => n.id === selected),
    view.focus,
  )
  /** Las funciones del programa, como chips que se arrastran a una llamada. */
  const palette = view.functions
    .filter((fn) => fn.id !== view.focus?.id)
    .map((fn) => ({ id: fn.id, name: fn.name, signature: fn.signature, params: fn.params }))
  const add = (template: TemplateId) => {
    act({ type: 'add', template, ...place })
  }
  const canvasLabel = program
    ? `Diagrama de ${file ?? 'Python'}: ${program.nodes.length} nodos y ${program.edges.length} conexiones`
    : 'Lienzo vacío'

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border-card px-3 py-2">
        <span className="text-xs font-semibold tracking-widest text-ink-faint">PRYSEL</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-muted" title={file ?? undefined}>
          {file ?? 'Sin archivo Python'}
        </span>
        <span className="text-[11px] text-ink-faint" aria-live="polite">
          {program ? `${program.nodes.length} nodos · ${program.edges.length} conexiones` : ''}
        </span>
        {program && (
          <RunControls
            kernel={kernel}
            problem={problem}
            hasSelection={selected !== null}
            onRunAll={() => {
              run('all')
            }}
            onRunSelected={() => {
              if (selected !== null) run([selected])
            }}
            onInterrupt={() => {
              post({ type: 'interrupt' })
            }}
            onRestart={() => {
              post({ type: 'restart' })
            }}
          />
        )}
        <FunctionMenu functions={view.functions} focus={view.focus} onOpen={view.open} />
        {program && <AddNodeMenu onAdd={add} where={addWhere} />}
        <DensityControl value={density} onChange={changeDensity} />
      </header>

      {unsupported.length > 0 && (
        <div
          role="note"
          className="border-b border-border-card bg-surface px-3 py-1.5 text-[11px] leading-4 text-ink-muted"
        >
          {unsupported.length} construcciones sin entender (líneas{' '}
          {unsupported.map((u) => u.line).join(', ')}) — se muestran como nodos opacos.
        </div>
      )}

      <main className="min-h-0 flex-1 p-3">
        {program && program.nodes.length > 0 ? (
          <Canvas
            nodes={canvasNodes}
            edges={canvasEdges}
            density={density}
            onEnter={view.enter}
            onControlChange={changeControl}
            onAction={act}
            onRun={(id) => {
              run([id])
            }}
            stateOf={stateOf}
            extraMenu={viewerMenu}
            onUnpin={(id) => {
              const key = pins.find((p) => pinNodeId(p) === id)
              if (key) pin(key)
            }}
            addTarget={'into' in place ? place.into : null}
            palette={palette}
            addToModule={view.focus === null}
            selected={selected}
            onSelect={setSelected}
            interactive
            height="fill"
            fitKey={view.viewKey}
            showActions
            showStatus={started}
            ariaLabel={canvasLabel}
          />
        ) : (
          <EmptyState />
        )}
      </main>

      {outputOpen && selectedView && selectedView.state !== 'never' && statementNode && (
        <OutputPanel
          title={statementNode.label}
          view={selectedView}
          assets={selectedView.seq === undefined ? undefined : assets.get(selectedView.seq)}
          pinned={(name) =>
            pins.some((p) => sameKey(p, { id: statementNode.id, hash: selectedView.hash, name }))
          }
          onPin={(name) => {
            pin({ id: statementNode.id, hash: selectedView.hash, name })
          }}
          onClose={() => {
            setOutputOpen(false)
          }}
        />
      )}
    </div>
  )
}

/** Los botones de ejecución y cómo está el motor. */
function RunControls({
  kernel,
  problem,
  hasSelection,
  onRunAll,
  onRunSelected,
  onInterrupt,
  onRestart,
}: {
  kernel: KernelStatus
  problem: string | null
  hasSelection: boolean
  onRunAll: () => void
  onRunSelected: () => void
  onInterrupt: () => void
  onRestart: () => void
}) {
  const busy = kernel === 'busy' || kernel === 'starting'
  const button =
    'px-2 py-1 text-[11px] text-ink-muted hover:text-ink disabled:opacity-40 disabled:hover:text-ink-muted'
  return (
    <div className="flex items-center gap-2">
      <div
        role="group"
        aria-label="Ejecución"
        className="flex overflow-hidden rounded-md border border-border-card bg-surface"
      >
        <button type="button" className={button} onClick={onRunAll} disabled={busy}>
          ▶ Todo
        </button>
        <button
          type="button"
          className={button}
          onClick={onRunSelected}
          disabled={busy || !hasSelection}
          title="Ejecuta el nodo seleccionado y lo que necesita (Mayús+Intro)"
        >
          ▶ Selección
        </button>
        <button type="button" className={button} onClick={onInterrupt} disabled={kernel !== 'busy'}>
          ■ Parar
        </button>
        <button
          type="button"
          className={button}
          onClick={onRestart}
          disabled={kernel === 'stopped'}
        >
          ↻ Reiniciar
        </button>
      </div>
      <span
        className={`text-[11px] ${kernel === 'dead' ? 'text-[var(--chip-error-fg)]' : 'text-ink-faint'}`}
        title={problem ?? undefined}
        aria-live="polite"
      >
        {KERNEL_LABEL[kernel]}
      </span>
    </div>
  )
}

function DensityControl({
  value,
  onChange,
}: {
  value: Density
  onChange: (next: Density) => void
}) {
  return (
    <div
      role="group"
      aria-label="Densidad del lienzo"
      className="flex overflow-hidden rounded-md border border-border-card bg-surface"
    >
      {DENSITIES.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={d === value}
          aria-label={`Densidad ${DENSITY_LABELS[d]}`}
          onClick={() => onChange(d)}
          className={`px-2 py-1 text-[11px] ${
            d === value ? 'bg-ink text-void' : 'text-ink-muted hover:text-ink'
          }`}
        >
          {DENSITY_LABELS[d]}
        </button>
      ))}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center" role="status">
      <div className="max-w-xs">
        <p className="text-sm text-ink">Sin diagrama que mostrar</p>
        <p className="mt-1 text-xs leading-5 text-ink-faint">
          Abre un archivo <code className="type-code">.py</code> y concéntralo para ver su diagrama,
          o ejecuta «Prysel: Abrir lienzo». En un archivo vacío, empieza con «Añadir».
        </p>
      </div>
    </div>
  )
}
