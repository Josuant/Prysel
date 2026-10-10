import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Density, NodeAction, TemplateId } from '@prysel/morphology'
import { buildProgram, createPythonParser, type Program, type PythonParser } from '@prysel/python'
import type { SemanticEdge } from '@prysel/spatial'
import { actionEdits, applyEdits, editsFor } from '@prysel/python/edits'
import {
  AddNodeMenu,
  Canvas,
  addPlace,
  FunctionMenu,
  Segmented,
  toCanvasNodes,
  useProgramView,
  type ControlModel,
  type GistScene,
} from '@prysel/ui'
import runtimeWasm from '@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm?url'
import pythonWasm from '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm?url'

/**
 * El recorrido completo, en vivo: Python → AST → grafo semántico → clasificación espacial
 * → diagrama. Es el mismo código que corre dentro de la extensión de VS Code; aquí el
 * archivo es un campo de texto en vez del editor.
 */

const EXAMPLE = `# Programa de ejemplo: suma dos números.
numeroA = 5
numero2 = float(input("Ingresa el segundo número: "))  # puede ser negativo


def suma(a, b):
    """Suma dos números y devuelve el resultado."""
    return a + b


def _main():
    # Punto de entrada: decide qué mostrar según el signo del segundo número.
    if numero2 < 0:
        print("El número ingresado es negativo. Por favor, ingresa un número positivo.")
    else:
        # Aquí ya sabemos que el número es válido.
        suma_resultado = suma(numeroA, numero2)
        print(f"La suma de {numeroA} y {numero2} es: {suma_resultado}")
`

const NO_EDGES: SemanticEdge[] = []
const NO_SECTIONS: NonNullable<Program['sections']> = []

export function LiveParser() {
  // `?code=` (texto en Base64) sustituye al ejemplo: permite enlazar o capturar un programa concreto.
  const [source, setSource] = useState(() => {
    const given = new URLSearchParams(location.search).get('code')
    if (given === null) return EXAMPLE
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(given), (c) => c.charCodeAt(0)))
    } catch {
      return EXAMPLE
    }
  })
  const [program, setProgram] = useState<Program | null>(null)
  // `?live=normal` abre la demo en esa densidad: permite fotografiar una vista exacta.
  const [density, setDensity] = useState<Density>(() => {
    const asked = new URLSearchParams(window.location.search).get('live')
    return asked === 'normal' || asked === 'expanded' ? asked : 'compact'
  })
  const [error, setError] = useState<string | null>(null)
  const [ms, setMs] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const parserRef = useRef<PythonParser | null>(null)

  const analyse = useCallback((code: string, selectLine?: number) => {
    const parser = parserRef.current
    if (!parser) return
    const started = performance.now()
    try {
      const next = buildProgram(parser.parse(code), code)
      setProgram(next)
      // Lo que se acaba de crear queda enfocado: se localiza por la línea en la que se escribió.
      if (selectLine !== undefined) {
        const created = next.nodes.find((n) => n.line === selectLine)
        if (created) setSelected(created.id)
      }
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

  /**
   * Un campo cambió en el lienzo: se reescribe ese trozo del texto de la izquierda. Es el mismo
   * camino que sigue la extensión de VS Code, con el campo de texto en lugar del editor.
   */
  const changeControl = (id: string, next: ControlModel) => {
    const node = program?.nodes.find((n) => n.id === id)
    if (!node) return
    const edits = editsFor(node, next)
    if (edits.length === 0) return
    const rewritten = applyEdits(source, edits)
    setSource(rewritten)
    analyse(rewritten)
  }

  /**
   * Una acción sobre un nodo (reescribirlo como código, eliminarlo, duplicarlo, renombrarlo) o
   * algo que se añade: se traduce a ediciones de texto y se escribe en el campo de la izquierda.
   */
  const act = (action: NodeAction) => {
    if (!program) return
    const change = actionEdits(program, action)
    if (change.edits.length === 0) return
    const rewritten = applyEdits(source, change.edits)
    setSource(rewritten)
    if (action.type === 'delete' && action.id === selected) setSelected(null)
    analyse(rewritten, change.select?.line)
  }

  const canvasHeight = Number(new URLSearchParams(location.search).get('h')) || 460
  // Compacto pliega las funciones (vista de pájaro: qué recibe y qué devuelve cada una);
  // normal y expandido las abren como territorios que envuelven su cuerpo.
  // `?gists=` (JSON en Base64: nombre de función → escena) le pone a cada una su tarjeta «Qué hace»: aquí no
  // hay un motor que ejecute nada, así que la escena viene dada. Sirve para ver y fotografiar la tarjeta.
  const [gists] = useState<Record<string, GistScene>>(() => {
    const given = new URLSearchParams(location.search).get('gists')
    if (given === null) return {}
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(given), (c) => c.charCodeAt(0)))
      return JSON.parse(text) as Record<string, GistScene>
    } catch {
      return {}
    }
  })
  const canvasNodes = useMemo(
    () =>
      program
        ? toCanvasNodes(program.nodes).map((node) => {
            const scene = node.kind === 'abstraction.collapsed' ? gists[node.label] : undefined
            return scene ? { ...node, gist: scene } : node
          })
        : [],
    [program, gists],
  )
  const view = useProgramView(canvasNodes, program?.edges ?? NO_EDGES, density, {
    flow: true,
    sections: program?.sections ?? NO_SECTIONS,
    // `?arch=0` vuelve a la columna de etapas, para comparar con la arquitectura.
    architecture: new URLSearchParams(location.search).get('arch') !== '0',
  })
  const nodes = view.nodes
  // `?fn=nombre` abre esa función al cargar: para capturar la vista de una función sin pasar por el menú.
  const askedFunction = useRef(new URLSearchParams(location.search).get('fn'))
  const { functions, open } = view
  useEffect(() => {
    const wanted = functions.find((fn) => fn.name === askedFunction.current)
    if (!wanted) return
    askedFunction.current = null
    open(wanted.id)
  }, [functions, open])
  /** Dónde va lo que se añade: dentro del territorio seleccionado, tras otro nodo, o al final de lo que se ve. */
  const { where: addWhere, place } = addPlace(
    program?.nodes.find((n) => n.id === selected),
    view.focus,
  )
  /** Las funciones del programa, como chips que se arrastran a una llamada. */
  const palette = view.functions
    .filter((fn) => fn.id !== view.focus?.id)
    .map((fn) => ({
      id: fn.id,
      name: fn.name,
      signature: fn.signature,
      params: fn.params,
      ...(fn.scope === undefined ? {} : { scope: fn.scope }),
    }))
  const add = (template: TemplateId) => {
    act({ type: 'add', template, ...place })
  }

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
        <AddNodeMenu onAdd={add} where={addWhere} />
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
            // `?h=` da otro alto al lienzo (y encuadra entero): para capturar un programa grande.
            height={canvasHeight}
            {...(canvasHeight === 460 ? {} : { fitMode: 'contain' as const })}
            interactive
            onEnter={view.enter}
            onOpen={view.descend}
            architecture={view.architecture}
            onControlChange={changeControl}
            onAction={act}
            addTarget={'into' in place ? place.into : null}
            palette={palette}
            addToModule={view.focus === null}
            selected={selected}
            onSelect={setSelected}
            fitKey={view.viewKey}
            // Como en la extensión: el programa se lee hacia abajo, como un diagrama de flujo.
            axis="vertical"
            controls
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
