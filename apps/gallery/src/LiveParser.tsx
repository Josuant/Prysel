import { useCallback, useEffect, useRef, useState } from 'react'
import type { Density } from '@prysel/morphology'
import { buildProgram, createPythonParser, type Program, type PythonParser } from '@prysel/python'
import { collapse, groupsFromContainers, type SemanticEdge } from '@prysel/spatial'
import { Canvas, Segmented, type CanvasNode } from '@prysel/ui'
import runtimeWasm from '@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm?url'
import pythonWasm from '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm?url'

/**
 * El recorrido completo, en vivo: Python → AST → grafo semántico → clasificación espacial
 * → diagrama. Es el mismo código que corre dentro de la extensión de VS Code; aquí el
 * archivo es un campo de texto en vez del editor.
 */

const EXAMPLE = `import pandas as pd

THRESHOLD = 1000
sales = pd.read_csv("data/sales.csv")
big = sales[sales.amount > THRESHOLD]
summary = big.groupby("region").amount.sum()
display(summary)

def resumir(ventas, minimo=0):
    filtradas = ventas[ventas.amount > minimo]
    total = filtradas.amount.sum()
    return total

total = 0
for fila in big.itertuples():
    total = total + fila.amount
`

function toCanvasNodes(program: Program): CanvasNode[] {
  return program.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    code: node.code,
    meta: `línea ${node.line}`,
    ...(node.ops === undefined ? {} : { metrics: { ops: node.ops } }),
    ...(node.contains ? { contains: node.contains } : {}),
  }))
}

export function LiveParser() {
  const [source, setSource] = useState(EXAMPLE)
  const [program, setProgram] = useState<Program | null>(null)
  const [density, setDensity] = useState<Density>('compact')
  /** Colapsado, una función es un solo nodo; abierto, se ve su cuerpo en el mismo plano. */
  const [collapsed, setCollapsed] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ms, setMs] = useState(0)
  const parserRef = useRef<PythonParser | null>(null)

  const analyse = useCallback((code: string) => {
    const parser = parserRef.current
    if (!parser) return
    const started = performance.now()
    try {
      setProgram(buildProgram(parser.parse(code)))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setMs(performance.now() - started)
  }, [])

  useEffect(() => {
    let cancelled = false
    void createPythonParser({ runtime: runtimeWasm, language: pythonWasm })
      .then((parser) => {
        if (cancelled) {
          parser.dispose()
          return
        }
        parserRef.current = parser
        analyse(source)
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
    // Solo al montar: el análisis posterior lo dispara cada cambio del texto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Colapsar las funciones es lo que mantiene legible un archivo con estructura:
  // cada `def` se convierte en un nodo en el que se puede entrar.
  const view = (() => {
    if (!program) return { nodes: [] as CanvasNode[], edges: [] as SemanticEdge[], folded: 0 }
    const all = toCanvasNodes(program)
    if (!collapsed) return { nodes: all, edges: program.edges, folded: 0 }
    const graph = {
      nodes: program.nodes.map((n) => ({
        id: n.id,
        role: 'transform' as const,
        size: { w: 0, h: 0 },
        ...(n.contains ? { contains: n.contains } : {}),
      })),
      edges: program.edges,
    }
    const { graph: result, applied } = collapse(graph, groupsFromContainers(graph))
    const kept = new Set(result.nodes.map((n) => n.id))
    return {
      nodes: all
        .filter((n) => kept.has(n.id))
        .map((n) => ({ ...n, openable: n.contains !== undefined })),
      edges: result.edges,
      folded: applied.length,
    }
  })()
  const nodes = view.nodes

  return (
    <section className="mt-20">
      <h2 className="type-architecture">DE PYTHON AL LIENZO, EN VIVO</h2>
      <p className="type-secondary mt-1 max-w-3xl text-ink-muted">
        Escribe Python a la izquierda y el diagrama se rehace a la derecha. Es el recorrido entero
        funcionando: tree-sitter analiza el texto, el analizador resuelve qué es cada sentencia y de
        dónde viene cada valor, y la gramática espacial decide la forma. Lo que no entiende lo marca
        como opaco en vez de inventárselo, y el código a medio escribir no lo tumba — que es justo
        lo que hace falta para dibujar mientras alguien teclea.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented
          value={density}
          options={['compact', 'normal', 'expanded']}
          onChange={(v) => {
            setDensity(v as Density)
          }}
        />
        <span className="type-tertiary text-ink-faint">
          {program
            ? `${nodes.length} nodos · ${view.edges.length} conexiones`
            : 'cargando el parser…'}
          {program && ` · analizado en ${ms < 0.1 ? '<0,1' : ms.toFixed(1)} ms`}
        </span>
        <label className="type-tertiary flex items-center gap-2 text-ink-faint">
          <input
            type="checkbox"
            checked={collapsed}
            onChange={(event) => {
              setCollapsed(event.target.checked)
            }}
          />
          Colapsar funciones{view.folded > 0 && ` (${view.folded})`}
        </label>
        {program && program.unsupported.length > 0 && (
          <span className="type-tertiary text-ink-faint">
            sin soporte: {program.unsupported.map((u) => `${u.type} (línea ${u.line})`).join(', ')}
          </span>
        )}
        {error && <span className="type-tertiary text-state-error">{error}</span>}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <label className="flex flex-col gap-2">
          <span className="type-field-label text-ink-faint">Python</span>
          <textarea
            className="type-code min-h-[420px] rounded-lg border border-border-card bg-surface p-4 text-ink"
            spellCheck={false}
            value={source}
            onChange={(event) => {
              setSource(event.target.value)
              analyse(event.target.value)
            }}
          />
        </label>
        {nodes.length > 0 ? (
          <Canvas
            nodes={nodes}
            edges={view.edges}
            density={density}
            height={460}
            interactive
            ariaLabel="Diagrama del programa escrito a la izquierda"
          />
        ) : (
          <div className="stage grid min-h-[420px] place-items-center rounded-lg border border-border-card">
            <span className="type-secondary text-ink-faint">
              {error ? 'No se pudo cargar el parser.' : 'Analizando…'}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
