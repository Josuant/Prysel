import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Density, NodeState } from '@prysel/morphology'
import type { Program } from '@prysel/python'
import type { SemanticEdge } from '@prysel/spatial'
import {
  AddNodeMenu,
  Button,
  Canvas,
  type CanvasNode,
  type NodeMenuItem,
  FunctionMenu,
  Icon,
  IconButton,
  SplitButton,
  StatusPill,
  addPlace,
  toCanvasNodes,
  useProgramView,
  usePrefersReducedMotion,
} from '@prysel/ui'
import { actionEdits } from '@prysel/python/edits'
import type { NodeAction, TemplateId } from '@prysel/morphology'
import {
  parseWebviewMessage,
  type DecisionMessage,
  type GeneratedMessage,
  type SayMessage,
  type StepMessage,
  type Theme,
} from '../../src/protocol.ts'
import type { Forced } from '../../src/jev/engine.ts'
import type { CallEntry } from '../../src/calls.ts'
import { CallsPanel } from './CallsPanel.tsx'
import { ChatDock, type ChatEntry } from './ChatDock.tsx'
import { CommandBar } from './CommandBar.tsx'
import { dragChips } from './dragging.ts'
import { markIn } from './marking.ts'
import { hush, speak, type OrderState } from './orders.ts'
import { curveOf, parseVisual, tableOf } from '../../src/jev/visual.ts'
import { topLevelOf } from '../../src/plan.ts'
import { indexOf, type Trace, type TraceIndex } from '../../src/trace.ts'
import type { Lesson } from '../../src/lesson.ts'
import { sectionBlocks } from '../../src/ai/sections.ts'
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
import {
  cursorNode,
  enclosingFunctionNode,
  nodeAtLine,
  observedAt,
  reachedNodes,
} from './player.ts'
import { currentMoment, lessonNotes, momentsOf, noteNodeId, resolveBeats } from './lessons.ts'
import { speakableNote, useNarration } from './useNarration.ts'
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
  /** Voz sincronizada al reproducir una lección: leer en voz alta la nota del momento actual. */
  narrate?: boolean
  /** Decir en voz alta lo que se hace con cada orden. */
  voice?: boolean
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
const NO_ECHO: readonly string[] = []
const NO_SECTIONS: NonNullable<Program['sections']> = []
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

/**
 * Lo que el anfitrión sabe hacer. En VS Code, todo; otro anfitrión (la web) puede no tener aún las órdenes
 * con IA, la pestaña de consultas o un guion de lección que abrir en un editor, y entonces no se ofrecen.
 */
export interface HostFeatures {
  orders: boolean
  calls: boolean
  editLesson: boolean
  /**
   * Interfaz de chat (la web, el móvil): sin barra de herramientas, el diagrama a pantalla completa y,
   * abajo, la conversación con la IA en lugar de la caja de órdenes.
   */
  chat?: boolean
  /** Sugerencias para empezar a hablar con la IA (en la interfaz de chat). */
  suggestions?: string[]
}

const ALL_FEATURES: HostFeatures = { orders: true, calls: true, editLesson: true }

export function App({ features = ALL_FEATURES }: { features?: HostFeatures } = {}) {
  // «Reducir movimiento» del sistema (o de VS Code, que lo refleja dentro del webview): la cámara del
  // reproductor salta directa en vez de deslizarse. El desplazamiento de los nodos ya se apaga solo
  // (`useMotion`, en `@prysel/ui`); esto es lo mismo para la cámara, que no pasa por ahí.
  const reducedMotion = usePrefersReducedMotion()
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
  /** Cuánto de lo cambiado desde el lienzo se puede deshacer y rehacer (lo cuenta la extensión). */
  const [history, setHistory] = useState({ undo: 0, redo: 0 })
  // Deshacer propio: en un webview, Ctrl+Z no llega al editor de texto. Dentro de un campo, en cambio,
  // es el deshacer del propio campo (lo que se está escribiendo), y no se toca.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const key = event.key.toLowerCase()
      const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)
      const undo = key === 'z' && !event.shiftKey
      if (!undo && !redo) return
      event.preventDefault()
      post({ type: redo ? 'redo' : 'undo' })
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  /** La orden en curso (o la última) y lo que el motor JEV hizo con ella. */
  const [order, setOrder] = useState<OrderState>({ phase: 'idle' })
  /** Las órdenes se numeran: una decisión que llega tarde, de una orden anterior, no se ejecuta. */
  const orderSeq = useRef(0)
  const lastOrder = useRef('')
  /** Cuándo salió la orden cuyo cambio aún no se ha visto pintado: de ahí sale su latencia. */
  const awaitingPaint = useRef<number | null>(null)
  /** La orden ya se decidió y su cambio va de camino: el siguiente programa que llegue es el suyo. */
  const paintArmed = useRef(false)
  /** Lo que se está creando lo pidió una orden: al aparecer, la cámara va a ello. */
  const orderCreates = useRef(false)
  /** A dónde lleva la cámara una orden: a un nodo, o a lo que haya en una línea. `key` cambia con cada gesto. */
  const [wanted, setWanted] = useState<{
    id?: string
    line?: number
    key: number
    /** Acaba de construirse (aparece con su animación) y, si lo dice el JEV, se enseña en su conjunto. */
    born?: boolean
    change?: 'changed' | 'leaving'
    wide?: boolean
    /** El trozo exacto de su código que se subraya mientras se habla de ella. */
    mark?: string[]
  } | null>(null)
  /** Lo que se le ha preguntado a cada modelo y lo que contestó, y si se está mirando esa pestaña. */
  const [calls, setCalls] = useState<CallEntry[]>([])
  /** La conversación con la IA (interfaz de chat): cada orden y lo que se contestó, y se fue contando. */
  const [chat, setChat] = useState<ChatEntry[]>([])
  /** Añade una frase a la respuesta de la orden en curso (o una respuesta nueva, si no hay ninguna). */
  const tellChat = useCallback((line: string) => {
    if (!line) return
    setChat((previous) => {
      const at = previous.findLastIndex((entry) => entry.role === 'ai')
      const entry = previous[at]
      if (!entry) return [...previous, { id: Date.now(), role: 'ai', text: '', lines: [line] }]
      if (entry.lines?.[entry.lines.length - 1] === line || entry.text === line) return previous
      const next = [...previous]
      next[at] = { ...entry, lines: [...(entry.lines ?? []), line] }
      return next
    })
  }, [])
  // La respuesta de la orden en curso sigue a su estado: pensando, preguntando, hecho (o construyendo).
  useEffect(() => {
    if (order.phase === 'idle') return
    const id = orderSeq.current
    setChat((previous) =>
      previous.map((entry) => {
        if (entry.role !== 'ai' || entry.id !== id) return entry
        if (order.phase === 'deciding') return { ...entry, busy: true, note: 'Pensando…' }
        if (order.phase === 'ask') {
          return { ...entry, busy: false, text: order.question, options: order.options, note: '' }
        }
        return {
          ...entry,
          text: order.say,
          tone: order.tone,
          busy: order.building === true,
          note: order.note ?? '',
          options: [],
          needsKey: order.needsKey === true,
        }
      }),
    )
  }, [order])
  const [tab, setTab] = useState<'canvas' | 'calls'>('canvas')
  /** Lo que se está diciendo de la pieza enfocada: se ve escrito junto a ella, como una nota. */
  const [caption, setCaption] = useState<string | null>(null)
  /** El comentario de entrada de una construcción: se ve mientras aún no hay diagrama. */
  const [intro, setIntro] = useState<string | null>(null)
  /** En qué está pensando la IA ahora mismo (mientras no hay nada nuevo que ver): se enseña en el diagrama. */
  const [thinking, setThinking] = useState<string | null>(null)
  /** La IA que redacta y el motor que decide ahora: lo dice la extensión. */
  const [models, setModels] = useState<{ ai: string | null; jev: string | null } | null>(null)
  const spotSeq = useRef(0)
  const [voice, setVoice] = useState<boolean>(() => saved().voice ?? true)
  /** El cambio de una orden ya está en el lienzo: en cuanto se pinte, se sabe cuánto tardó. */
  const markPainted = useCallback(() => {
    const from = awaitingPaint.current
    if (from === null || !paintArmed.current) return
    awaitingPaint.current = null
    paintArmed.current = false
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const totalMs = performance.now() - from
        setOrder((previous) =>
          previous.phase === 'done' && previous.totalMs === undefined
            ? { ...previous, totalMs }
            : previous,
        )
      })
    })
  }, [])
  // Lo que se acaba de crear queda enfocado: se localiza por la línea en la que se escribió.
  const focusCreated = useCallback((created: Program, line: number) => {
    const node = created.nodes.find((n) => n.line === line)
    if (!node) return
    setSelected(node.id)
    if (orderCreates.current) {
      orderCreates.current = false
      setWanted({ id: node.id, key: ++spotSeq.current })
    }
  }, [])
  /** Lo que llega del motor JEV se atiende con lo que el lienzo sabe ahora (ver más abajo). */
  const onDecision = useRef<(message: DecisionMessage) => void>(() => undefined)
  const onGenerated = useRef<(message: GeneratedMessage) => void>(() => undefined)
  const onSay = useRef<(message: SayMessage) => void>(() => undefined)
  const onStep = useRef<(message: StepMessage) => void>(() => undefined)
  const { pending, change: changeControl, submit, received } = useWriteBack(post, focusCreated)
  const [theme, setTheme] = useState<Theme>('dark')
  const [density, setDensity] = useState<Density>(() => {
    const saved = vscode.getState() as SavedState | undefined
    return saved?.density ?? 'normal'
  })
  // Voz sincronizada (Fase E): apagada por defecto, se recuerda entre archivos (es una preferencia de
  // quien mira, no de la lección).
  const [narrate, setNarrate] = useState<boolean>(() => saved().narrate ?? false)
  const toggleNarrate = useCallback(() => {
    setNarrate((previous) => {
      const next = !previous
      vscode.setState({ ...saved(), narrate: next } satisfies SavedState)
      return next
    })
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = parseWebviewMessage(event.data)
      if (!message) return
      if (message.type === 'update') {
        setProgram(message.program)
        setFile(message.file ?? null)
        setVersion(message.version ?? null)
        received(message.program, message.version ?? null)
        markPainted()
      } else if (message.type === 'decision') {
        onDecision.current(message)
      } else if (message.type === 'generated') {
        onGenerated.current(message)
      } else if (message.type === 'say') {
        onSay.current(message)
      } else if (message.type === 'step') {
        onStep.current(message)
      } else if (message.type === 'call') {
        const entry = message.entry
        // La misma consulta llega varias veces (empieza, avanza, acaba): se queda la última versión.
        setCalls((previous) => {
          const at = previous.findIndex((call) => call.id === entry.id)
          const next =
            at < 0 ? [...previous, entry] : previous.map((call, i) => (i === at ? entry : call))
          return next.length > 150 ? next.slice(next.length - 150) : next
        })
      } else if (message.type === 'progress') {
        const text = message.text
        setThinking(text)
        setOrder((previous) =>
          previous.phase === 'done' ? { ...previous, note: text, building: true } : previous,
        )
      } else if (message.type === 'models') {
        setModels({ ai: message.ai, jev: message.jev })
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
      } else if (message.type === 'history') {
        setHistory({ undo: message.undo, redo: message.redo })
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
  }, [received, markPainted])

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
  useNarration({
    enabled: narrate,
    lang: lesson?.lang,
    text: moment ? speakableNote(moment.beat.note) : null,
    key: moment?.beat.id ?? null,
  })
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
  // El lienzo se lee hacia abajo, como diagrama de flujo (ver `axis` más abajo).
  // Con sus etapas: las fases con nombre del algoritmo, plegadas en normal hasta que se abren.
  const view = useProgramView(source, program?.edges ?? NO_EDGES, density, {
    flow: true,
    sections: program?.sections ?? NO_SECTIONS,
  })
  // Durante la reproducción, si el paso ocurre dentro de una función o un método que no se está viendo, el
  // lienzo entra en él solo: si no, solo se vería la llamada que lo abrió, nunca la línea que se ejecuta.
  // Al salir de la reproducción, se vuelve a lo que se estaba viendo antes de que empezara a seguir sola.
  const priorFocus = useRef<string | null>(null)
  const wasFollowing = useRef(false)
  const focusId = view.focus?.id ?? null
  const openView = view.open
  const homeOf = view.homeOf
  useEffect(() => {
    if (!program || !replay || !player.state?.event) {
      if (wasFollowing.current) {
        wasFollowing.current = false
        openView(priorFocus.current)
      }
      return
    }
    if (!wasFollowing.current) {
      wasFollowing.current = true
      priorFocus.current = focusId
    }
    const node = nodeAtLine(program, player.state.event.l)
    const fn = node ? enclosingFunctionNode(program, node) : null
    // Una función desplegada en el programa (la principal) se sigue viendo ahí, no aparte.
    const wanted = fn ? homeOf(fn.id) : null
    if (wanted !== focusId) openView(wanted)
  }, [program, replay, player.state, focusId, openView, homeOf])
  // El hueco que deja el esquema de una etapa (`...`) no es algo «sin entender»: se está escribiendo.
  const unsupported = (program?.unsupported ?? []).filter(
    (item) => !program?.nodes.some((n) => n.generating !== undefined && n.line === item.line),
  )
  /** Cuántos bloques largos no tienen etapas: la IA puede proponérselas. */
  const longBlocks = useMemo(() => (program ? sectionBlocks(program).length : 0), [program])
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
        ? cursorNode(
            program,
            player.state,
            new Set(view.nodes.map((node) => node.id)),
            view.representative,
          )
        : null,
    [program, replay, player.state, view.nodes, view.representative],
  )
  /**
   * Construcción progresiva: lo que la reproducción ya tocó. Solo cuando se le ha dado a reproducir (o se ha
   * dado un paso): con la traza grabada pero sin empezar, y sin reproducción, todo se ve a todo color.
   */
  const replayStarted = player.playing || player.step >= 0
  const reached = useMemo(
    () =>
      program && replay?.trace && replayStarted
        ? reachedNodes(program, replay.trace, player.step)
        : null,
    [program, replay, player.step, replayStarted],
  )
  /** Las piezas que una orden colocó y cuyo contenido aún se está escribiendo (lo dice su marca en el código). */
  const generating = useMemo(
    () =>
      new Set((program?.nodes ?? []).filter((n) => n.generating !== undefined).map((n) => n.id)),
    [program],
  )
  const modifierOf = useCallback(
    (id: string) => {
      if (generating.has(id)) return 'generating' as const
      if (!reached || reached.has(id)) return undefined
      // Una etapa no es una sentencia: se enciende en cuanto la ejecución toca algo de lo que tiene dentro.
      const shown = view.nodes.find((node) => node.id === id)
      if (shown?.kind === 'space.section' && shown.contains?.some((inner) => reached.has(inner))) {
        return undefined
      }
      return 'pending' as const
    },
    [reached, view.nodes, generating],
  )
  // Un momento de la lección abre la etapa donde está la sentencia de la que habla (y la cierra al pasar).
  const momentNode = moment
    ? (resolved.find((entry) => entry.beat.id === moment.beat.id)?.node ?? null)
    : null
  const reveal = view.reveal
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
            view.representative,
          )
        : { nodes: [], links: [] },
    [
      program,
      lesson,
      resolved,
      replay,
      player.step,
      view.nodes,
      view.functions,
      view.representative,
    ],
  )
  /**
   * Los nodos auxiliares: no son parte del programa, ayudan a entenderlo. Las **ayudas visuales** que una
   * sentencia lleva en su marca (`# prysel:ver …`: la curva de una función, una tabla de valores), y el
   * nodo que dice que **la IA está pensando**, colgado de donde está trabajando.
   */
  const deciding = order.phase === 'deciding'
  /** La pieza de la que se está hablando (la que señala la orden), si se ve. */
  const captionAt =
    wanted === null
      ? undefined
      : (wanted.id ?? program?.nodes.find((n) => n.range && n.line === wanted.line)?.id)
  /**
   * De dónde saca sus datos la pieza de la que se habla: los nodos cuyos valores usa. Se iluminan con ella,
   * para que se vea la relación (lo que se definió antes y ahora se aprovecha).
   */
  const echo = useMemo(() => {
    if (captionAt === undefined || !program) return NO_ECHO
    const sources = program.edges
      .filter(
        (edge) =>
          edge.to === captionAt &&
          (edge.relation === 'dependency' || edge.relation === 'transform'),
      )
      .map((edge) => edge.from)
    return sources.length === 0 ? NO_ECHO : [...new Set(sources)]
  }, [program, captionAt])
  const extras = useMemo(() => {
    const nodes: CanvasNode[] = []
    const links: SemanticEdge[] = []
    const byId = new Map((program?.nodes ?? []).map((n) => [n.id, n]))
    const visible = new Set(view.nodes.map((n) => n.id))
    for (const source of program?.nodes ?? []) {
      const visual = source.aid ? parseVisual(source.aid) : null
      if (!visual) continue
      // Si su sentencia no se ve (su etapa está plegada), la ayuda cuelga de la tarjeta que la contiene.
      const anchor = visible.has(source.id) ? source.id : view.representative(source.id)
      if (anchor === null) continue
      const shown = { id: anchor }
      const id = `aid:${source.id}`
      nodes.push({
        id,
        kind: 'output.display',
        label: visual.title,
        viewer: {
          title: visual.title,
          subtitle:
            visual.kind === 'serie' ? `${visual.values.length} valores` : `y = ${visual.formula}`,
          aid: true,
          ...(visual.kind === 'serie'
            ? {
                series: {
                  at: visual.values.map((_, index) => index),
                  values: visual.values,
                  n: visual.values.length,
                },
              }
            : visual.kind === 'curva'
              ? { series: curveOf(visual) }
              : {
                  table: {
                    columns: [
                      { name: 'x', dtype: '' },
                      { name: 'y', dtype: '' },
                    ],
                    rows: tableOf(visual),
                  },
                }),
        },
      })
      links.push({ from: shown.id, to: id, relation: 'transform' })
    }
    const busy = thinking ?? (deciding ? 'Decidiendo qué hacer…' : null)
    if (busy !== null) {
      // Donde trabaja: el hueco que espera contenido, lo último que tocó, lo seleccionado o el final.
      const hole = view.nodes.find((n) => byId.get(n.id)?.generating !== undefined)?.id
      const anchor =
        hole ??
        view.nodes.find((n) => n.id === wanted?.id)?.id ??
        view.nodes.find((n) => n.id === selected)?.id ??
        view.nodes[view.nodes.length - 1]?.id
      if (anchor !== undefined) {
        nodes.push({
          id: 'prysel:thinking',
          kind: 'output.display',
          label: 'La IA está pensando',
          viewer: { title: 'La IA está pensando', text: [busy], busy: true },
        })
        links.push({ from: anchor, to: 'prysel:thinking', relation: 'transform' })
      }
    }
    return { nodes, links, busy }
  }, [program, view.nodes, view.representative, thinking, deciding, wanted, selected])
  const canvasNodes = useMemo(
    () => [...view.nodes, ...viewers.nodes, ...notes.nodes, ...extras.nodes],
    [view.nodes, viewers.nodes, notes.nodes, extras.nodes],
  )
  const canvasEdges = useMemo(
    () => [...view.edges, ...viewers.links, ...notes.links, ...extras.links],
    [view.edges, viewers.links, notes.links, extras.links],
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
  // Con una etapa elegida, lo nuevo va al final de la etapa (tras su última sentencia).
  const selectedShown = view.nodes.find((node) => node.id === selected)
  const anchorId =
    selectedShown?.kind === 'space.section'
      ? selectedShown.section?.members[selectedShown.section.members.length - 1]
      : selected
  const { where: addWhere, place } = addPlace(
    program?.nodes.find((n) => n.id === anchorId),
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
      ...(fn.scope === undefined ? {} : { scope: fn.scope }),
    }))
  const add = (template: TemplateId) => {
    act({ type: 'add', template, ...place })
  }

  // ── Órdenes: lo que se escribe o se dicta lo decide el motor JEV, y aquí se ejecuta (docs/voz.md). ──
  const shownIds = useMemo(() => new Set(view.nodes.map((node) => node.id)), [view.nodes])
  /** Lleva la cámara a un elemento (si no se ve, el lienzo va a donde está: ver el efecto de más abajo). */
  const goTo = (id: string) => {
    setSelected(id)
    setWanted({ id, key: ++spotSeq.current })
  }
  const wantedId = wanted
    ? (wanted.id ?? program?.nodes.find((n) => n.range && n.line === wanted.line)?.id)
    : undefined
  const spotId =
    wantedId === undefined
      ? null
      : shownIds.has(wantedId)
        ? wantedId
        : view.representative(wantedId)
  const spotKey = wanted?.key
  const spotBorn = wanted?.born === true
  const spotChange = wanted?.change
  const spotWide = wanted?.wide === true
  const spotlight = useMemo(
    () =>
      spotId !== null && spotKey !== undefined
        ? {
            id: spotId,
            key: spotKey,
            ...(spotBorn ? { born: true } : {}),
            ...(spotChange ? { change: spotChange } : {}),
            ...(spotWide ? { wide: true } : {}),
          }
        : null,
    [spotId, spotKey, spotBorn, spotChange, spotWide],
  )
  // Mientras se habla de una pieza, se subraya —como con un rotulador— el trozo exacto del que habla la
  // frase. Se espera un momento a que el nodo esté pintado en su sitio; al pasar a otra cosa, se quita.
  // Llegan varios candidatos, por orden: se subraya el primero que el nodo tenga escrito.
  const spotMark = wanted?.mark?.join('\n')
  useEffect(() => {
    if (spotId === null || !spotMark) return
    let unmark: (() => void) | null = null
    const timer = setTimeout(() => {
      const node = document.querySelector(`.react-flow__node[data-id="${CSS.escape(spotId)}"]`)
      unmark = node ? markIn(node, spotMark.split('\n')) : null
    }, 450)
    return () => {
      clearTimeout(timer)
      unmark?.()
    }
  }, [spotId, spotMark, spotKey])
  // Una pieza que acaba de aparecer y usa algo definido antes: se coge el chip de aquello y se arrastra
  // hasta la casilla donde se usa, para que se vea que no sale de la nada. Se espera a que la cámara llegue.
  useEffect(() => {
    if (spotId === null || !spotBorn || reducedMotion || echo.length === 0) return
    let stop: (() => void) | null = null
    const find = (id: string) =>
      document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
    const timer = setTimeout(() => {
      const node = find(spotId)
      const sources = echo.map(find).filter((source) => source !== null)
      stop = node ? dragChips(node, sources) : null
    }, 600)
    return () => {
      clearTimeout(timer)
      stop?.()
    }
  }, [spotId, spotBorn, spotKey, echo, reducedMotion])
  // Lo que una orden quiere enseñar puede no estar a la vista: dentro de una función que no se está viendo
  // (se entra en ella) o de una etapa plegada (se abre). Vale también para lo que se acaba de crear.
  // Las etapas plegadas que hay que abrir: la del momento de la lección y la de lo que una orden enseña. Van
  // juntas, en un solo efecto: dos que abrieran cada uno lo suyo se cerrarían el uno al otro sin parar.
  const revealMoment = replay && momentNode ? momentNode : null
  const revealIds = useMemo(
    () => [
      ...(revealMoment === null ? [] : [revealMoment]),
      ...(wantedId === undefined ? [] : [wantedId]),
    ],
    [revealMoment, wantedId],
  )
  useEffect(() => {
    reveal(revealIds)
  }, [revealIds, reveal])
  useEffect(() => {
    if (!program || wantedId === undefined || spotId !== null) return
    const node = program.nodes.find((n) => n.id === wantedId)
    if (!node) return
    const fn = node.kind === 'abstraction.collapsed' ? node : enclosingFunctionNode(program, node)
    const home = fn ? homeOf(fn.id) : null
    if (home !== focusId) openView(home)
  }, [program, wantedId, spotId, homeOf, focusId, openView])
  const sendOrder = (text: string, force?: Forced) => {
    if (version === null) return
    hush()
    const id = ++orderSeq.current
    lastOrder.current = text
    awaitingPaint.current = performance.now()
    paintArmed.current = false
    setOrder({ phase: 'deciding', text })
    setChat((previous) => [
      ...previous.slice(-60),
      { id, role: 'user', text },
      { id, role: 'ai', text: '', busy: true, note: 'Pensando…' },
    ])
    post({
      type: 'command',
      id,
      text,
      version,
      selected,
      focus: view.focus?.id ?? null,
      ...(force ? { force } : {}),
    })
  }
  useEffect(() => {
    onDecision.current = (message) => {
      if (message.id !== orderSeq.current) return
      const text = lastOrder.current
      const { directive } = message
      const meta = message.engine
        ? { engine: message.engine, jevMs: message.jevMs, evidence: message.evidence }
        : {}
      const tell = (say: string) => {
        if (voice) speak(say)
      }
      const stop = (say: string, tone: 'muted' | 'error', needsKey = false) => {
        awaitingPaint.current = null
        setOrder({ phase: 'done', text, say, tone, ...meta, ...(needsKey ? { needsKey } : {}) })
        tell(say)
      }
      if (directive.kind === 'ask') {
        awaitingPaint.current = null
        setOrder({ phase: 'ask', text, question: directive.question, options: directive.options })
        tell(directive.question)
        return
      }
      if (directive.kind !== 'do') {
        const failed = directive.kind === 'failed'
        stop(directive.say, failed ? 'error' : 'muted', failed && directive.needsKey === true)
        return
      }
      if (!program || message.version !== version) {
        stop('El archivo cambió mientras tanto. Repite la orden.', 'error')
        return
      }
      const { effect } = directive
      paintArmed.current = true
      if (effect.type === 'action') {
        // Lo que no se puede escribir (un sitio que no admite esa pieza) se dice: no se queda en silencio.
        if (actionEdits(program, effect.action).edits.length === 0) {
          stop('Eso no se puede hacer ahí.', 'error')
          return
        }
        orderCreates.current = effect.action.type === 'add'
        act(effect.action)
      } else if (effect.type === 'undo' || effect.type === 'redo') post({ type: effect.type })
      else if (effect.type === 'run') run(effect.ids)
      else if (effect.type === 'trace') post({ type: 'trace', version })
      else if (effect.type === 'fold') view.enter(effect.id)
      if (directive.focus !== undefined) goTo(directive.focus)
      setOrder({
        phase: 'done',
        text,
        say: directive.say,
        tone: 'ok',
        ...meta,
        ...(directive.pending ? { note: 'Escribiendo su contenido…' } : {}),
        ...(effect.type === 'compose' || effect.type === 'modify'
          ? { note: 'Leyendo lo que ya hay…', building: true }
          : {}),
        ...(effect.type === 'lesson' ? { note: 'Generando la lección…' } : {}),
      })
      tell(directive.say)
      // Lo que cambia el código se mide cuando vuelve reanalizado; lo demás ya está en el lienzo.
      if (effect.type !== 'action' && effect.type !== 'undo' && effect.type !== 'redo')
        markPainted()
    }
    onStep.current = (message) => {
      setThinking(null)
      // Una pieza puede aparecer antes que su explicación (llega detrás): mientras, se queda lo que se decía.
      setOrder((previous) =>
        previous.phase === 'done'
          ? {
              ...previous,
              building: true,
              ...(message.say ? { note: `${message.index} · ${message.say}` } : {}),
            }
          : previous,
      )
      // Al terminar de decirlo se avisa: la extensión no enseña lo siguiente hasta entonces.
      const heard = (spoke: boolean) => {
        if (message.seq !== undefined) post({ type: 'spoken', seq: message.seq, spoke })
      }
      if (voice && message.say) speak(message.say, 'es', false, heard)
      else heard(false)
      setCaption(message.say ? message.say : null)
      if (message.say) tellChat(message.say)
      // La pieza aparece (con su animación) y la cámara va a ella; de lejos, si el JEV dice que hay que ver el conjunto.
      setWanted({
        line: message.line,
        key: ++spotSeq.current,
        // `told`: la pieza ya estaba; solo se la vuelve a mirar mientras se cuenta.
        ...(message.effect === 'changed' || message.effect === 'leaving'
          ? { change: message.effect }
          : message.effect === 'told'
            ? {}
            : { born: true }),
        ...(message.wide ? { wide: true } : {}),
        ...(message.mark?.length ? { mark: message.mark } : {}),
      })
    }
    onGenerated.current = (message) => {
      if (message.done) {
        setThinking(null)
        setCaption(null)
        setIntro(null)
      }
      const note = message.done
        ? (message.say ?? message.error ?? '')
        : message.ok
          ? (message.say ?? 'Contenido escrito.')
          : `No se pudo escribir su contenido${message.error ? ` (${message.error})` : ''}: se queda la plantilla.`
      setOrder((previous) =>
        previous.phase === 'done'
          ? {
              ...previous,
              note,
              building: false,
              ...(message.done && !message.ok ? { tone: 'error' as const } : {}),
              ...(message.jevMs !== undefined
                ? { jevMs: (previous.jevMs ?? 0) + message.jevMs }
                : {}),
              // Lo que el JEV juzgó de lo escrito se suma a lo que decidió antes.
              ...(message.evidence
                ? { evidence: [...(previous.evidence ?? []), ...message.evidence] }
                : {}),
            }
          : previous,
      )
      // El cierre de una construcción se dice detrás de la frase del último paso, sin cortarla.
      if (message.done) {
        if (voice && note) speak(note, 'es', true)
        return
      }
      if (!message.ok) return
      if (message.say && voice) speak(message.say)
      if (message.line !== undefined) setWanted({ line: message.line, key: ++spotSeq.current })
    }
    onSay.current = (message) => {
      setThinking(null)
      tellChat(message.text)
      setOrder((previous) =>
        previous.phase === 'done' ? { ...previous, note: message.text } : previous,
      )
      const heard = (spoke: boolean) => {
        if (message.seq !== undefined) post({ type: 'spoken', seq: message.seq, spoke })
      }
      if (voice) speak(message.text, 'es', false, heard)
      else heard(false)
      setIntro(message.seq === undefined ? null : message.text)
    }
  })
  const canvasLabel = program
    ? `Diagrama de ${file ?? 'Python'}: ${program.nodes.length} nodos y ${program.edges.length} conexiones`
    : 'Lienzo vacío'

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      {!features.chat && (
        <header className="appbar">
          <div className="appbar__lead">
            <span className="appbar__mark" aria-hidden>
              P
            </span>
            <span className="appbar__file" title={file ?? undefined}>
              <Icon name="file" size={14} />
              <span className="appbar__file-name">
                {file ? baseName(file) : 'Sin archivo Python'}
              </span>
            </span>
            <FunctionMenu
              functions={view.functions}
              methods={view.methods}
              focus={view.focus}
              trail={view.trail}
              onOpen={view.open}
              onCrumb={view.descend}
            />
          </div>
          {features.calls && (
            <div role="tablist" aria-label="Qué se ve" className="segmented appbar__tabs">
              <button
                type="button"
                role="tab"
                className="segmented__item"
                aria-selected={tab === 'canvas'}
                aria-pressed={tab === 'canvas'}
                onClick={() => {
                  setTab('canvas')
                }}
              >
                Diagrama
              </button>
              <button
                type="button"
                role="tab"
                className="segmented__item"
                aria-selected={tab === 'calls'}
                aria-pressed={tab === 'calls'}
                title="Lo que se le pregunta a cada modelo (la IA que redacta y el JEV que decide) y lo que contesta"
                onClick={() => {
                  setTab('calls')
                }}
              >
                Consultas{calls.length > 0 ? ` ${calls.length}` : ''}
                {calls.some((call) => call.status === 'running') ? ' ·' : ''}
              </button>
            </div>
          )}
          <span className="sr-only" aria-live="polite">
            {program ? `${program.nodes.length} nodos · ${program.edges.length} conexiones` : ''}
          </span>
          {program && (
            <div className="appbar__actions">
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
              <span className="appbar__sep" aria-hidden />
              <Button
                icon="step"
                disabled={version === null || recording?.status === 'running'}
                title={
                  recording?.status === 'failed'
                    ? recording.message
                    : 'Reproduce el programa línea a línea, viendo cómo cambia cada valor'
                }
                onClick={() => {
                  if (version !== null) post({ type: 'trace', version })
                }}
              >
                {recording?.status === 'running' ? 'Grabando…' : 'Paso a paso'}
              </Button>
              {file && features.editLesson && (
                <Button
                  icon="book"
                  title={
                    lesson
                      ? 'Abrir el guion de la lección'
                      : 'Crea el guion de la lección de este archivo (un .lesson.json junto a él)'
                  }
                  onClick={() => {
                    post({ type: 'newLesson' })
                  }}
                >
                  {lesson ? lesson.title : 'Lección'}
                </Button>
              )}
              {/* Solo si hay bloques largos sin etapas: la IA propone sus comentarios de sección. */}
              {file && longBlocks > 0 && (
                <Button
                  icon="section"
                  title={`${longBlocks === 1 ? 'Hay un bloque largo' : `Hay ${longBlocks} bloques largos`} sin etapas: la IA propone sus comentarios de sección, y los revisas antes de que se escriban`}
                  onClick={() => {
                    post({ type: 'proposeSections' })
                  }}
                >
                  Etapas
                </Button>
              )}
              <span className="appbar__sep" aria-hidden />
              <IconButton
                icon="undo"
                label="Deshacer lo último que se cambió en el lienzo (Ctrl+Z)"
                disabled={history.undo === 0}
                onClick={() => {
                  post({ type: 'undo' })
                }}
              />
              <IconButton
                icon="redo"
                label="Rehacer (Ctrl+Mayús+Z)"
                disabled={history.redo === 0}
                onClick={() => {
                  post({ type: 'redo' })
                }}
              />
            </div>
          )}
        </header>
      )}

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
        <main className="relative min-h-0 min-w-0 flex-1">
          {/* La pestaña «Consultas» va encima del diagrama, que sigue montado (no pierde su cámara). */}
          {tab === 'calls' && (
            <div className="calls-layer">
              <CallsPanel
                calls={calls}
                onClear={() => {
                  setCalls([])
                  post({ type: 'clearCalls' })
                }}
              />
            </div>
          )}
          {program && program.nodes.length > 0 ? (
            <ErrorBoundary label="No se pudo dibujar el lienzo" resetKey={program}>
              <Canvas
                nodes={canvasNodes}
                edges={canvasEdges}
                density={density}
                onEnter={view.enter}
                onOpen={view.descend}
                onControlChange={changeControl}
                onAction={act}
                onRun={(id) => {
                  run([id])
                }}
                stateOf={stateOf}
                modifierOf={modifierOf}
                {...(lesson
                  ? {
                      // Una nota dejada a mano en otro sitio se guarda en el guion, junto a esa nota.
                      onNoteMove: (id: string, offset: { x: number; y: number } | null) => {
                        const beat = lesson.beats.find((b) => noteNodeId(b) === id)
                        if (beat) post({ type: 'noteMove', beat: beat.id, offset })
                      },
                    }
                  : {})}
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
                framed={false}
                interactive
                height="fill"
                fitKey={view.viewKey}
                cursor={cursor}
                spotlight={spotlight}
                echo={echo}
                showActions
                showStatus={started}
                ariaLabel={canvasLabel}
                animate={!reducedMotion}
                controls
              />
            </ErrorBoundary>
          ) : (
            <EmptyState thinking={extras.busy} intro={intro} chat={features.chat === true} />
          )}
          {program && (
            <>
              {/* Lo que se está diciendo, escrito: un subtítulo a mano sobre el lienzo. Va fijo (no en el
                  diagrama) para que se lea con cualquier zoom y la cámara no tenga que ir a buscarlo. */}
              {caption !== null && (
                <div className="canvas-caption" role="status" aria-live="off" key={caption}>
                  {caption}
                </div>
              )}
              {features.chat ? (
                (view.functions.length > 0 || view.methods.length > 0 || view.focus !== null) && (
                  <div className="canvas-float" data-at="top-left">
                    <FunctionMenu
                      functions={view.functions}
                      methods={view.methods}
                      focus={view.focus}
                      trail={view.trail}
                      onOpen={view.open}
                      onCrumb={view.descend}
                    />
                  </div>
                )
              ) : (
                <>
                  <div className="canvas-float" data-at="top-right">
                    <DensityControl value={density} onChange={changeDensity} />
                  </div>
                  <div className="canvas-float" data-at="bottom-left">
                    <AddNodeMenu onAdd={add} where={addWhere} placement="up" label="Añadir paso" />
                  </div>
                </>
              )}
              {features.orders && !features.chat && (
                <div className="canvas-float" data-at="bottom-center">
                  <CommandBar
                    state={order}
                    voice={voice}
                    onToggleVoice={() => {
                      if (voice) hush()
                      vscode.setState({ ...saved(), voice: !voice } satisfies SavedState)
                      setVoice(!voice)
                    }}
                    onSubmit={(text) => {
                      sendOrder(text)
                    }}
                    onChoose={(option) => {
                      // Una salida que es otra orden, ya completa, se manda tal cual; si no, aclara la que había.
                      if (option.order) sendOrder(option.order)
                      else sendOrder(lastOrder.current, option.force)
                    }}
                    onDismiss={() => {
                      // Una decisión que llegue después ya no es de nadie.
                      orderSeq.current++
                      awaitingPaint.current = null
                      hush()
                      post({ type: 'stopOrder' })
                      setOrder({ phase: 'idle' })
                    }}
                    onKey={() => {
                      post({ type: 'jevKey' })
                    }}
                    onTyping={hush}
                    onStop={() => {
                      hush()
                      post({ type: 'stopOrder' })
                    }}
                    models={models}
                    onPickModel={() => {
                      post({ type: 'pickModel' })
                    }}
                  />
                </div>
              )}
            </>
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
              track={lesson?.track}
              trail={lesson?.trail}
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
            narrate={narrate}
            onToggleNarrate={toggleNarrate}
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

      {features.chat && features.orders && (
        <ChatDock
          entries={chat}
          building={order.phase === 'done' && order.building === true}
          voice={voice}
          ai={models ? models.ai : ''}
          suggestions={features.suggestions ?? []}
          onSubmit={(text) => {
            sendOrder(text)
          }}
          onChoose={(option) => {
            if (option.order) sendOrder(option.order)
            else sendOrder(lastOrder.current, option.force)
          }}
          onStop={() => {
            hush()
            post({ type: 'stopOrder' })
          }}
          onToggleVoice={() => {
            if (voice) hush()
            vscode.setState({ ...saved(), voice: !voice } satisfies SavedState)
            setVoice(!voice)
          }}
          onSettings={() => {
            post({ type: 'pickModel' })
          }}
          onTyping={hush}
        />
      )}
    </div>
  )
}

/** Cómo se enseña cada estado del motor: una palabra y un tono. */
const KERNEL_TONE: Record<KernelStatus, 'idle' | 'ready' | 'busy' | 'error'> = {
  stopped: 'idle',
  starting: 'busy',
  idle: 'ready',
  busy: 'busy',
  dead: 'error',
}

/** Ejecutar (la acción principal, con sus variantes en la flecha) y cómo está el motor. */
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
  return (
    <>
      <StatusPill
        tone={KERNEL_TONE[kernel]}
        label={KERNEL_LABEL[kernel]}
        {...(problem ? { title: problem } : {})}
      />
      <SplitButton
        icon="play"
        label="Ejecutar"
        title="Ejecuta todo el programa"
        disabled={busy}
        onClick={onRunAll}
        menuLabel="Más formas de ejecutar"
        actions={[
          { label: 'Ejecutar todo', icon: 'play', disabled: busy, onClick: onRunAll },
          {
            label: 'Ejecutar la selección',
            icon: 'play',
            hint: 'Mayús+Intro',
            disabled: busy || !hasSelection,
            onClick: onRunSelected,
          },
          { label: 'Detener', icon: 'stop', disabled: kernel !== 'busy', onClick: onInterrupt },
          {
            label: 'Reiniciar el motor',
            icon: 'rotate',
            disabled: kernel === 'stopped',
            onClick: onRestart,
          },
        ]}
      />
    </>
  )
}

/** Cuánto detalle enseña el lienzo: compacto (la vista de pájaro), normal o expandido. */
function DensityControl({
  value,
  onChange,
}: {
  value: Density
  onChange: (next: Density) => void
}) {
  return (
    <div role="group" aria-label="Densidad del lienzo" className="segmented segmented--float">
      {DENSITIES.map((d) => (
        <button
          key={d}
          type="button"
          className="segmented__item"
          aria-pressed={d === value}
          aria-label={`Densidad ${DENSITY_LABELS[d]}`}
          onClick={() => {
            onChange(d)
          }}
        >
          {DENSITY_LABELS[d]}
        </button>
      ))}
    </div>
  )
}

/** El nombre del archivo, sin su carpeta. */
function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file
}

function EmptyState({
  thinking,
  intro,
  chat,
}: {
  thinking: string | null
  intro: string | null
  chat: boolean
}) {
  // El comentario de entrada: lo que se va a hacer, mientras aún no hay nada dibujado.
  if (intro !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6" role="status">
        <p className="intro-card">{intro}</p>
      </div>
    )
  }
  // Aún no hay diagrama, pero la IA ya está en ello: se dice aquí, donde va a aparecer.
  if (thinking !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6" role="status">
        <div className="thinking-card">La IA está pensando · {thinking}</div>
      </div>
    )
  }
  if (chat) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center" role="status">
        <div className="max-w-xs">
          <p className="text-base text-ink">¿Qué quieres aprender?</p>
          <p className="mt-2 text-sm leading-6 text-ink-faint">
            Pídeselo a la IA abajo, por ejemplo «enséñame la recursión», y mira cómo el diagrama se
            construye aquí mientras te lo explica.
          </p>
        </div>
      </div>
    )
  }
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
