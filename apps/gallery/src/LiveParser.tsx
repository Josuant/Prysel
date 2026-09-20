import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Density } from '@prysel/morphology'
import { buildProgram, createPythonParser, type Program, type PythonParser } from '@prysel/python'
import type { SemanticEdge } from '@prysel/spatial'
import { Canvas, FunctionMenu, Segmented, toCanvasNodes, useProgramView } from '@prysel/ui'
import runtimeWasm from '@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm?url'
import pythonWasm from '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm?url'

/**
 * El recorrido completo, en vivo: Python → AST → grafo semántico → clasificación espacial
 * → diagrama. Es el mismo código que corre dentro de la extensión de VS Code; aquí el
 * archivo es un campo de texto en vez del editor.
 */

const EXAMPLE = `numeroA = 5
numero2 = float(input("Ingresa el segundo número: "))


def suma(a, b):
    return a + b


def _main():
    if numero2 < 0:
        print("El número ingresado es negativo. Por favor, ingresa un número positivo.")
    else:
        suma_resultado = suma(numeroA, numero2)
        print(f"La suma de {numeroA} y {numero2} es: {suma_resultado}")
`

const NO_EDGES: SemanticEdge[] = []

export function LiveParser() {
  const [source, setSource] = useState(EXAMPLE)
  const [program, setProgram] = useState<Program | null>(null)
  // `?live=normal` abre la demo en esa densidad: permite fotografiar una vista exacta.
  const [density, setDensity] = useState<Density>(() => {
    const asked = new URLSearchParams(window.location.search).get('live')
    return asked === 'normal' || asked === 'expanded' ? asked : 'compact'
  })
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

  // Compacto pliega las funciones (vista de pájaro: qué recibe y qué devuelve cada una);
  // normal y expandido las abren como territorios que envuelven su cuerpo.
  const canvasNodes = useMemo(() => (program ? toCanvasNodes(program.nodes) : []), [program])
  const view = useProgramView(canvasNodes, program?.edges ?? NO_EDGES, density)
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
            ? `${nodes.length} ${nodes.length === 1 ? 'nodo' : 'nodos'} · ${view.edges.length} ${view.edges.length === 1 ? 'conexión' : 'conexiones'}`
            : 'cargando el parser…'}
          {program && ` · analizado en ${ms < 0.1 ? '<0,1' : ms.toFixed(1)} ms`}
        </span>
        <FunctionMenu functions={view.functions} focus={view.focus} onOpen={view.open} />
        {view.folded > 0 && (
          <span className="type-tertiary text-ink-faint">{view.folded} funciones plegadas</span>
        )}
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
            onEnter={view.enter}
            fitKey={view.viewKey}
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
