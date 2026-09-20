import { useEffect, useState } from 'react'
import type { Program } from '@prysel/python'
import { Canvas, type CanvasNode } from '@prysel/ui'
import { parseWebviewMessage, type Theme } from '../../src/protocol.ts'

const vscode = acquireVsCodeApi()

/** Del programa analizado a los nodos que dibuja el lienzo. */
function toCanvasNodes(program: Program): CanvasNode[] {
  return program.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    code: node.code,
    ...(node.ops === undefined ? {} : { metrics: { ops: node.ops } }),
    ...(node.contains ? { contains: node.contains } : {}),
  }))
}

export function App() {
  const [program, setProgram] = useState<Program | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>('dark')

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

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border-card px-4 py-2">
        <span className="text-xs font-semibold tracking-widest text-ink-faint">PRYSEL</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">
          {file ?? 'Abre un archivo Python y pulsa «Prysel: Abrir lienzo»'}
        </span>
        <span className="text-xs text-ink-faint">
          {program ? `${program.nodes.length} nodos` : ''}
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-auto p-4">
        {program && program.nodes.length > 0 ? (
          <Canvas nodes={toCanvasNodes(program)} edges={program.edges} density="normal" />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center text-center">
      <p className="text-sm text-ink-faint">
        Sin diagrama que mostrar. Abre un archivo <code>.py</code> y vuelve a abrir el lienzo.
      </p>
    </div>
  )
}
