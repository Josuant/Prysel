import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Density } from '@prysel/morphology'
import type { Program } from '@prysel/python'
import type { SemanticEdge } from '@prysel/spatial'
import {
  AddNodeMenu,
  Canvas,
  FunctionMenu,
  addPlace,
  toCanvasNodes,
  useProgramView,
} from '@prysel/ui'
import { actionEdits } from '@prysel/python/edits'
import type { NodeAction, TemplateId } from '@prysel/morphology'
import { parseWebviewMessage, type Theme } from '../../src/protocol.ts'
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
}

const NO_EDGES: SemanticEdge[] = []

export function App() {
  const [program, setProgram] = useState<Program | null>(null)
  const [file, setFile] = useState<string | null>(null)
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
        received(message.program, message.version ?? null)
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

  const changeDensity = (next: Density) => {
    setDensity(next)
    vscode.setState({ density: next } satisfies SavedState)
  }

  const source = useMemo(() => {
    if (!program) return []
    return toCanvasNodes(program.nodes).map((node) =>
      pending[node.id] ? { ...node, control: pending[node.id] } : node,
    )
  }, [program, pending])

  // El programa enseña cada función una vez (como su llamada); una función se ve aparte.
  // Compacto pliega las funciones (vista de pájaro); normal y expandido las abren.
  const view = useProgramView(source, program?.edges ?? NO_EDGES, density)
  const unsupported = program?.unsupported ?? []

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
            nodes={view.nodes}
            edges={view.edges}
            density={density}
            onEnter={view.enter}
            onControlChange={changeControl}
            onAction={act}
            addTarget={'into' in place ? place.into : null}
            palette={palette}
            addToModule={view.focus === null}
            selected={selected}
            onSelect={setSelected}
            interactive
            height="fill"
            fitKey={view.viewKey}
            showActions
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
          o ejecuta «Prysel: Abrir lienzo». En un archivo vacío, empieza con «Añadir».
        </p>
      </div>
    </div>
  )
}
