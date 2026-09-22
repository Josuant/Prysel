import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { indexOf, type Trace, type TraceIndex } from '../../src/trace.ts'
import type { Lesson } from '../../src/lesson.ts'
import {
  chipHint,
  describeSummary,
  runCaption,
  type Assets,
  type KernelStatus,
  type RunState,
  type RunView,
} from '../../src/runs.ts'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { OutputPanel } from './OutputPanel.tsx'
import { PlayerBar } from './Player.tsx'
import { InsightDock, InsightToggles, type Answer } from './InsightCards.tsx'
import { INSIGHTS, type InsightId } from './insights.ts'
import { cursorNode, observedAt } from './player.ts'
import { currentMoment, lessonNotes, momentsOf, resolveBeats } from './lessons.ts'
import { usePlayer } from './usePlayer.ts'
import { curvesOf, loopRefs, observedInLoops, positionOf, type LoopRef } from './loops.ts'
import { chainRefs, describeStep, viewableStep, type ChainRef } from './chains.ts'
import {
  FIGURE,
  SERIES,
  STEP,
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
/** Lo guardado por el lienzo (densidad, visores, nodos para entender): se reescribe entero, sin perder nada. */
const saved = (): SavedState => (vscode.getState() as SavedState | undefined) ?? {}
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
  /** Los nodos para entender que se enseñan al reproducir, por archivo. */
  insights?: Record<string, InsightId[]>
}

/** A partir de este ancho, los nodos para entender van a un lado del lienzo; si no, debajo. */
const WIDE_PANEL = 1100

/** La grabación de la traza del programa: cómo va, y la traza lista para reproducir. */
interface Recording {
  /** La versión del texto que se grabó: si cambia, la grabación ya no vale. */
  version: number
  status: 'running' | 'done' | 'failed'
  index: TraceIndex | null
  trace: Trace | null
  message?: string
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
  const [recording, setRecording] = useState<Recording | null>(null)
  /** El guion de la lección de un archivo, o por qué no se pudo leer. */
  const [lessonState, setLessonState] = useState<{
    file: string
    lesson: Lesson | null
    error?: string
  } | null>(null)
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
      } else if (message.type === 'lesson') {
        setLessonState({
          file: message.file,
          lesson: message.lesson,
          ...(message.error ? { error: message.error } : {}),
        })
      } else if (message.type === 'trace') {
        setRecording({
          version: message.version,
          status: message.status,
          index: message.trace ? indexOf(message.trace) : null,
          trace: message.trace,
          ...(message.message ? { message: message.message } : {}),
        })
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
    vscode.setState({ ...saved(), density: nextDensity, pins: nextPins } satisfies SavedState)
  }
  const changeDensity = (next: Density) => {
    setDensity(next)
    remember(next, allPins)
  }
  /** Fija el valor de una sentencia en un visor del lienzo, o lo quita si ya estaba. */
  const pin = useCallback(
    (key: PinKey) => {
      const next = { ...allPins, [file ?? '']: togglePin(pins, key) }
      setAllPins(next)
      vscode.setState({ ...saved(), density, pins: next } satisfies SavedState)
    },
    [allPins, pins, file, density],
  )

  // La reproducción solo vale para el texto que se grabó: si el código cambió, se sale de ella.
  const replay = recording?.status === 'done' && recording.version === version ? recording : null
  // El guion solo vale para el archivo al que pertenece.
  const lesson = lessonState && lessonState.file === file ? lessonState.lesson : null
  const lessonError = lessonState && lessonState.file === file ? (lessonState.error ?? null) : null
  const resolved = useMemo(
    () => (program && lesson ? resolveBeats(program, lesson, replay?.trace ?? null) : []),
    [program, lesson, replay],
  )
  const moments = useMemo(() => momentsOf(resolved), [resolved])
  // La reproducción se detiene en cada momento del guion: hay algo que leer.
  const stops = useMemo(() => new Set(moments.map((moment) => moment.step)), [moments])
  const player = usePlayer(replay?.index ?? null, stops)

  // Los nodos para entender: los que eligió el alumno para este archivo, o los que pide la lección.
  const [insightChoice, setInsightChoice] = useState<Record<string, InsightId[]>>(
    () => saved().insights ?? {},
  )
  const insightIds = useMemo(
    () => insightChoice[file ?? ''] ?? lesson?.show ?? [],
    [insightChoice, file, lesson],
  )
  // Se enciende o apaga sobre lo que había en ese momento (dos pulsaciones seguidas no se pisan).
  const toggleInsight = (id: InsightId) => {
    setInsightChoice((previous) => {
      const current = previous[file ?? ''] ?? lesson?.show ?? []
      const now = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
      return { ...previous, [file ?? '']: INSIGHTS.filter((x) => now.includes(x)) }
    })
  }
  // Un guion que pide nodos para entender arranca la reproducción solo: si no, habría que darle antes al
  // botón «Paso a paso» para llegar a verlos (las tarjetas necesitan un paso concreto de la traza).
  const autoTraced = useRef<string | null>(null)
  useEffect(() => {
    if (version === null || !lesson?.show || lesson.show.length === 0) return
    const key = `${file ?? ''}@${version}`
    if (autoTraced.current === key) return
    // Ya hay algo grabado (o en marcha) para esta versión: no hace falta pedirlo otra vez.
    if (recording && recording.version === version) return
    autoTraced.current = key
    post({ type: 'trace', version })
  }, [lesson, version, file, recording])
  useEffect(() => {
    vscode.setState({ ...saved(), insights: insightChoice } satisfies SavedState)
  }, [insightChoice])
  // Las respuestas a las preguntas del guion valen para esta reproducción: otra traza empieza limpia.
  const [answered, setAnswered] = useState<{
    of: unknown
    map: Record<string, Answer>
  }>({ of: null, map: {} })
  const answers = answered.of === (replay?.index ?? null) ? answered.map : {}
  const moment = currentMoment(moments, player.step)
  const question = moment?.beat.ask
  const noAnswer: Answer = { text: '', checked: false }
  // Cuánto mide el panel decide dónde van los nodos para entender: a un lado, o debajo.
  const [wide, setWide] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(() => {
      setWide(root.clientWidth >= WIDE_PANEL)
    })
    observer.observe(root)
    return () => {
      observer.disconnect()
    }
  }, [])
  /** Lo que valen los nombres del programa en el paso que se está mirando. */
  const traced = useMemo(
    () => (program && replay && player.state ? observedAt(program, player.state) : null),
    [program, replay, player.state],
  )

  /** A qué sentencia de primer nivel pertenece cada nodo: es la unidad que se ejecuta. */
  const top = useMemo(() => (program ? topLevelOf(program) : new Map<string, string>()), [program])

  /** Los bucles que ya dieron vueltas, y la vuelta que se mira en cada uno (por defecto, la última). */
  const [scrub, setScrub] = useState<Record<string, number>>({})
  // Mientras algo corre, la vuelta que se mira es la última (se sigue en vivo): una elección de la ejecución anterior no vale.
  if (Object.keys(scrub).length > 0 && Object.values(runs).some((r) => r.state === 'running')) {
    setScrub({})
  }
  const refs = useMemo(
    () => (program ? loopRefs(program, top, runs) : new Map<string, LoopRef>()),
    [program, top, runs],
  )
  /** Lo que valen, en la vuelta que se mira, los nombres que definen los nodos de dentro de un bucle. */
  const inLoops = useMemo(
    () => (program ? observedInLoops(program, refs, scrub) : new Map()),
    [program, refs, scrub],
  )

  /** Las cadenas de pasos que ya se evaluaron: lo que valía tras cada paso. */
  const chainsOf = useMemo(
    () => (program ? chainRefs(program, top, runs) : new Map<string, ChainRef>()),
    [program, top, runs],
  )

  const source = useMemo(() => {
    if (!program) return []
    const built = toCanvasNodes(program.nodes).map((node) => {
      const shown = pending[node.id] ? { ...node, control: pending[node.id] } : node
      // Solo la propia sentencia lleva lo observado: sus nodos de dentro no definen nombres del programa.
      const inner = inLoops.get(node.id)
      // Una cadena que ya se evaluó enseña, junto a cada paso, lo que quedaba tras él (y se puede ver en un visor).
      const chained = chainsOf.get(node.id)
      const steps = chained
        ? chained.previews.map((summary, index) => ({
            ...(summary ? { short: describeSummary(summary), long: describeStep(summary) } : {}),
            ...(viewableStep(summary)
              ? {
                  onView: () => {
                    const hash = runs[chained.statement]?.hash
                    if (hash !== undefined) {
                      pin({
                        id: chained.statement,
                        hash,
                        name: `${STEP}${chained.key}|${index}`,
                      })
                    }
                  },
                }
              : {}),
          }))
        : undefined
      const laps = refs.get(node.id)
      // Un bucle que ya dio vueltas se recorre en su propia cabecera: la vuelta que se mira y sus valores.
      const lapsView = laps
        ? {
            n: laps.view.n,
            done: laps.view.done,
            idx: laps.view.idx,
            names: laps.view.names,
            position: positionOf(laps.view, scrub[node.id]),
            onPosition: (position: number) => {
              setScrub((previous) => ({ ...previous, [node.id]: position }))
            },
          }
        : undefined
      const view = top.get(node.id) === node.id ? runs[node.id] : undefined
      if (!view) {
        // Un nodo de dentro de un bucle: lo que valió en la vuelta que se mira; un bucle, cuántas dio.
        return inner || laps || steps
          ? {
              ...shown,
              ...(laps ? { meta: `línea ${node.line} · ${laps.view.n} vueltas` } : {}),
              ...(lapsView ? { laps: lapsView } : {}),
              ...(inner ? { observed: inner } : {}),
              ...(steps ? { steps } : {}),
            }
          : shown
      }
      const caption = runCaption(view)
      const observed = Object.fromEntries(
        Object.entries(view.values ?? {}).map(([name, summary]) => {
          const short = chipHint(summary)
          return [name, { ...(short ? { short } : {}), long: describeSummary(summary) }]
        }),
      )
      return {
        ...shown,
        ...(caption
          ? { meta: `línea ${node.line} · ${caption}${laps ? ` · ${laps.view.n} vueltas` : ''}` }
          : {}),
        ...(Object.keys(observed).length > 0 || inner
          ? { observed: { ...observed, ...inner } }
          : {}),
        ...(lapsView ? { laps: lapsView } : {}),
        ...(steps ? { steps } : {}),
      }
    })
    // Reproduciendo, los chips enseñan lo que valía en ese paso, no lo de la última ejecución.
    if (!traced) return built
    return built.map((node) => {
      const rest = { ...node }
      delete rest.observed
      const now = traced.get(node.id)
      return now ? { ...rest, observed: now } : rest
    })
  }, [program, pending, runs, top, refs, inLoops, scrub, chainsOf, pin, traced])

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
  const selectedLoop = selected === null ? undefined : refs.get(selected)
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

  // Con la reproducción activa: ← y → dan un paso, y Espacio la pone en marcha o la pausa.
  const { previous, next, toggle } = player
  const replaying = replay !== null
  useEffect(() => {
    if (!replaying) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, button, [contenteditable]')
      ) {
        return
      }
      if (event.key === 'ArrowLeft') previous()
      else if (event.key === 'ArrowRight') next()
      else if (event.key === ' ') toggle()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [replaying, previous, next, toggle])

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
  /** El nodo por el que va la reproducción (el más cercano que se ve). */
  const cursor = useMemo(
    () =>
      program && replay && player.state
        ? cursorNode(program, player.state, new Set(view.nodes.map((node) => node.id)))
        : null,
    [program, replay, player.state, view.nodes],
  )
  /** Las notas de la lección, con su flecha: todas sobre el diagrama, o las del momento si se reproduce. */
  const notes = useMemo(
    () =>
      program && lesson
        ? lessonNotes(
            program,
            resolved,
            replay ? player.step : null,
            new Set(view.nodes.map((node) => node.id)),
            new Set(view.functions.map((fn) => fn.id)),
          )
        : { nodes: [], links: [] },
    [program, lesson, resolved, replay, player.step, view.nodes, view.functions],
  )
  const canvasNodes = useMemo(
    () => [...view.nodes, ...viewers.nodes, ...notes.nodes],
    [view.nodes, viewers.nodes, notes.nodes],
  )
  const canvasEdges = useMemo(
    () => [...view.edges, ...viewers.links, ...notes.links],
    [view.edges, viewers.links, notes.links],
  )
  /** Lo que ofrece el menú de un nodo ejecutado: ver cada uno de sus valores en un visor. */
  const viewerMenu = (id: string): NodeMenuItem[] => {
    // Un bucle que dio vueltas: sus curvas (lo que valió cada nombre en cada vuelta).
    const loop = refs.get(id)
    const owner = loop ? runs[loop.statement] : undefined
    const curves: NodeMenuItem[] =
      loop && owner
        ? curvesOf(loop.view)
            .slice(0, 6)
            .map((name) => {
              const key: PinKey = {
                id: loop.statement,
                hash: owner.hash,
                name: SERIES + loop.key + '|' + name,
              }
              const on = pins.some((p) => sameKey(p, key))
              return {
                label: on ? 'Quitar la curva de «' + name + '»' : 'Ver la curva de «' + name + '»',
                onSelect: () => {
                  pin(key)
                },
              }
            })
        : []
    const stmt = runs[id]
    if (top.get(id) !== id || !stmt || stmt.state === 'never') return curves
    const names = viewableOf(stmt, stmt.seq === undefined ? undefined : assets.get(stmt.seq))
    const values = names.slice(0, 6).map((name) => {
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
    return [...values, ...curves]
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
    .map((fn) => ({
      id: fn.id,
      name: fn.name,
      signature: fn.signature,
      params: fn.params,
      ...(fn.line === undefined ? {} : { line: fn.line }),
    }))
  const add = (template: TemplateId) => {
    act({ type: 'add', template, ...place })
  }
  const canvasLabel = program
    ? `Diagrama de ${file ?? 'Python'}: ${program.nodes.length} nodos y ${program.edges.length} conexiones`
    : 'Lienzo vacío'

  return (
    <div ref={rootRef} className="flex h-full flex-col">
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
        {program && (
          <button
            type="button"
            className="rounded-md border border-border-card bg-surface px-2 py-1 text-[11px] text-ink-muted hover:text-ink disabled:opacity-40"
            disabled={version === null || recording?.status === 'running'}
            title={
              recording?.status === 'failed'
                ? recording.message
                : 'Reproduce el programa línea a línea'
            }
            onClick={() => {
              if (version !== null) post({ type: 'trace', version })
            }}
          >
            {recording?.status === 'running' ? 'Grabando…' : '▶ Paso a paso'}
          </button>
        )}
        {program && file && (
          <button
            type="button"
            className="rounded-md border border-border-card bg-surface px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
            title={
              lesson
                ? 'Abrir el guion de la lección'
                : 'Crea el guion de la lección de este archivo (un .lesson.json junto a él)'
            }
            onClick={() => {
              post({ type: 'newLesson' })
            }}
          >
            {lesson ? `Lección: ${lesson.title}` : '＋ Lección'}
          </button>
        )}
        <FunctionMenu functions={view.functions} focus={view.focus} onOpen={view.open} />
        {program && <AddNodeMenu onAdd={add} where={addWhere} />}
        <DensityControl value={density} onChange={changeDensity} />
      </header>

      {lessonError && (
        <div
          role="alert"
          className="border-b border-border-card bg-surface px-3 py-1.5 text-[11px] leading-4 text-[var(--chip-error-fg)]"
        >
          El guion de la lección no se puede usar: {lessonError}
        </div>
      )}

      {unsupported.length > 0 && (
        <div
          role="note"
          className="border-b border-border-card bg-surface px-3 py-1.5 text-[11px] leading-4 text-ink-muted"
        >
          {unsupported.length} construcciones sin entender (líneas{' '}
          {unsupported.map((u) => u.line).join(', ')}) — se muestran como nodos opacos.
        </div>
      )}

      <div className={`flex min-h-0 flex-1 ${wide ? 'flex-row' : 'flex-col'}`}>
        <main className="min-h-0 min-w-0 flex-1 p-3">
          {program && program.nodes.length > 0 ? (
            <ErrorBoundary label="No se pudo dibujar el lienzo" resetKey={program}>
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
                axis="vertical"
                interactive
                height="fill"
                fitKey={view.viewKey}
                cursor={cursor}
                showActions
                showStatus={started}
                ariaLabel={canvasLabel}
              />
            </ErrorBoundary>
          ) : (
            <EmptyState />
          )}
        </main>

        {program && replay && player.state && (insightIds.length > 0 || question) && (
          <ErrorBoundary label="No se pudo dibujar los nodos para entender" resetKey={replay}>
            <InsightDock
              program={program}
              index={replay.index as TraceIndex}
              step={player.step}
              state={player.state}
              ids={insightIds}
              ask={question}
              askStep={moment?.step}
              answer={(moment && answers[moment.beat.id]) || noAnswer}
              onAnswer={(next) => {
                if (moment) {
                  setAnswered({
                    of: replay.index,
                    map: { ...answers, [moment.beat.id]: next },
                  })
                }
              }}
              side={wide}
            />
          </ErrorBoundary>
        )}
      </div>

      {program && replay?.trace && (
        <ErrorBoundary label="No se pudo dibujar la reproducción" resetKey={replay}>
          <PlayerBar
            program={program}
            player={player}
            truncated={replay.trace.truncated}
            failure={replay.trace.error}
            extras={<InsightToggles ids={insightIds} onToggle={toggleInsight} />}
            {...(lesson
              ? {
                  lesson: {
                    title: lesson.title,
                    moments: moments.map((moment) => ({
                      step: moment.step,
                      text: moment.beat.note.text,
                      ...(moment.beat.note.title ? { title: moment.beat.note.title } : {}),
                    })),
                    unreached: resolved.filter((r) => r.node !== null && r.step === null).length,
                  },
                }
              : {})}
            onClose={() => {
              setRecording(null)
            }}
          />
        </ErrorBoundary>
      )}

      {outputOpen && selectedView && selectedView.state !== 'never' && statementNode && (
        <ErrorBoundary label="No se pudo dibujar la salida" resetKey={selectedView}>
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
            {...(selectedLoop && selectedView
              ? {
                  loop: {
                    view: selectedLoop.view,
                    position: positionOf(selectedLoop.view, scrub[selectedLoop.node]),
                    onPosition: (position: number) => {
                      setScrub((previous) => ({ ...previous, [selectedLoop.node]: position }))
                    },
                    pinned: (name: string) =>
                      pins.some((p) =>
                        sameKey(p, {
                          id: selectedLoop.statement,
                          hash: selectedView.hash,
                          name: SERIES + selectedLoop.key + '|' + name,
                        }),
                      ),
                    onPin: (name: string) => {
                      pin({
                        id: selectedLoop.statement,
                        hash: selectedView.hash,
                        name: SERIES + selectedLoop.key + '|' + name,
                      })
                    },
                  },
                }
              : {})}
            onClose={() => {
              setOutputOpen(false)
            }}
          />
        </ErrorBoundary>
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
