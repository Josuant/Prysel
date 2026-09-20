import { useEffect, useMemo, useState } from 'react'
import type { Density } from '@prysel/morphology'
import type { Program } from '@prysel/python'
import type { SemanticEdge } from '@prysel/spatial'
import { Canvas, FunctionMenu, toCanvasNodes, useProgramView } from '@prysel/ui'
import { parseWebviewMessage, type Theme } from '../../src/protocol.ts'

const vscode = acquireVsCodeApi()

const DENSITIES: Density[] = ['compact', 'normal', 'expanded']
const DENSITY_LABELS: Record<Density, string> = {
  compact: 'Compacto',
  normal: 'Normal',
  expanded: 'Expandido',
}

interface SavedState {
  density?: Density
}

const NO_EDGES: SemanticEdge[] = []

export function App() {
  const [program, setProgram] = useState<Program | null>(null)
  const [file, setFile] = useState<string | null>(null)
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
      } else if (message.type === 'theme') {
        setTheme(message.theme)
      }
    }
    window.addEventListener('message', onMessage)
    vscode.postMessage({ type: 'ready' })
    return () => {
      window.removeEventListener('message', onMessage)
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const changeDensity = (next: Density) => {
    setDensity(next)
    vscode.setState({ density: next } satisfies SavedState)
  }

  const source = useMemo(() => (program ? toCanvasNodes(program.nodes) : []), [program])
  // El programa enseña cada función una vez (como su llamada); una función se ve aparte.
  // Compacto pliega las funciones (vista de pájaro); normal y expandido las abren.
  const view = useProgramView(source, program?.edges ?? NO_EDGES, density)
  const unsupported = program?.unsupported ?? []
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
        <FunctionMenu functions={view.functions} focus={view.focus} onOpen={view.open} />
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
            nodes={view.nodes}
            edges={view.edges}
            density={density}
            onEnter={view.enter}
            interactive
            height="fill"
            fitKey={view.viewKey}
            showActions={false}
            showStatus={false}
            ariaLabel={canvasLabel}
          />
        ) : (
          <EmptyState />
        )}
      </main>
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
          o ejecuta «Prysel: Abrir lienzo».
        </p>
      </div>
    </div>
  )
}
