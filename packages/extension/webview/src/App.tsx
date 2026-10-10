import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Density, NodeState } from '@prysel/morphology'
import type { Program } from '@prysel/python'
import type { SemanticEdge } from '@prysel/spatial'
import {
  AddNodeMenu,
  Button,
  Canvas,
  factsText,
  withPlan,
  withStory,
  withVerdict,
  type PlannedModule,
  type CanvasNode,
  type ViewerContent,
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
  MAX_COVER_PARTS,
  MAX_COVER_PIECES,
  parseWebviewMessage,
  type DecisionMessage,
  type GeneratedMessage,
  type SayMessage,
  type StepMessage,
  type Theme,
} from '../../src/protocol.ts'
import type { Forced } from '../../src/jev/engine.ts'
import { MODULE_ROLES, shapeCandidates, type ArchShape, type ModuleRole } from '@prysel/spatial'
import type { CallEntry } from '../../src/calls.ts'
import { CallsPanel } from './CallsPanel.tsx'
import { ChatDock, type ChatEntry } from './ChatDock.tsx'
import { CommandBar } from './CommandBar.tsx'
import { answerTo, rejection } from './answering.ts'
import { dissolve, dragChips, flyNode, gesture } from './dragging.ts'
import { morph } from './effects.ts'
import { coverOf, draftOf, filledBy, piecesOf, sketchOf, type Sketch } from './drafting.ts'
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
import { functionsIn } from '../../src/gist/facts.ts'
import { loopsIn } from '../../src/gist/laps.ts'
import { triesIn } from '../../src/gist/net.ts'
import { classesIn } from '../../src/gist/blueprint.ts'
import { conditionsIn } from '../../src/gist/branch.ts'
import type { Gist, RunSummary } from '../../src/gist/gist.ts'
import { RunPanel } from './RunPanel.tsx'
import { sampleScene } from './gisting.ts'
import { TryPanel } from './TryPanel.tsx'
import { moduleStory, outcomeOf } from './outcome.ts'
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
  /** Lo que se propone con el lienzo vacío: ideas que construir, dichas como las diría cualquiera. */
  starters?: string[]
  /**
   * El reproductor y los nodos para entender (variables, pila, árbol de llamadas…) empiezan recogidos. Una
   * lección no se pone a reproducir sola al abrirla: el reproductor aparece cuando se pide «Paso a paso»
   * (con su botón, o hablando con la IA), y dentro de él los nodos se eligen pulsando «Entender». En una
   * pantalla pequeña quitan sitio al diagrama, que es lo que se viene a ver.
   */
  foldInsights?: boolean
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
    /** Su parte del plan se deja plegada: se señala la tarjeta de la parte, no se abre. */
    folded?: boolean
    /** La línea donde se queda la cámara: la cabecera de lo que se construye. */
    anchor?: number
    /** El trozo exacto de su código que se subraya mientras se habla de ella. */
    mark?: string[]
  } | null>(null)
  /** Lo que se le ha preguntado a cada modelo y lo que contestó, y si se está mirando esa pestaña. */
  const [calls, setCalls] = useState<CallEntry[]>([])
  // «Qué hace» cada función: su muestra ejecutada, tal como la mandó quien ejecuta el programa.
  const [gists, setGists] = useState<readonly Gist[]>([])
  // Cómo le fue al programa entero al ejecutarlo: lo que salió por pantalla.
  const [ran, setRan] = useState<RunSummary | null>(null)
  // Cuántas veces se ha asentado lo construido (llega su comprobación): el lienzo lo enseña entero.
  const [settled, setSettled] = useState(0)
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
  const [voiceOn, setVoice] = useState<boolean>(() => saved().voice ?? true)
  // Con el micrófono abierto no se habla en voz alta: se oiría a sí mismo y lo tomaría por una orden. Lo que
  // se iba a decir se lee (el subtítulo, el chat).
  const [micOpen, setMicOpen] = useState(false)
  const voice = voiceOn && !micOpen
  /** Lo que se le está oyendo decir al usuario ahora mismo (`null`: nada). */
  const [hearing, setHearing] = useState<string | null>(null)
  // Lo que lleva escrito en la caja del chat, sin mandar: el lienzo lo va esbozando, como lo que se le oye.
  const [typed, setTyped] = useState<string | null>(null)
  /** En un diagrama contado por su ejecución: enseñar también quién llama a quién. */
  const [showCalls, setShowCalls] = useState(false)
  /** El plan de lo que se construye, como arquitectura: cada módulo y de cuáles necesita algo. */
  const [planned, setPlanned] = useState<readonly PlannedModule[] | null>(null)
  /** Lo que dijo el JEV de cada arquitectura que se le preguntó (por su clave), y lo último que dijo. */
  const [archVerdicts, setArchVerdicts] = useState<Readonly<Record<string, ArchVerdict>>>({})
  const [archLast, setArchLast] = useState<ArchVerdict | null>(null)
  /**
   * Lo que ocupa la consola («Al ejecutarlo») en el rincón del lienzo, con su margen: el encuadre le deja
   * ese sitio. `null` si no está.
   */
  const [consoleBox, setConsoleBox] = useState<{ w: number; h: number } | null>(null)
  const consoleWatch = useRef<ResizeObserver | null>(null)
  const watchConsole = useCallback((element: HTMLDivElement | null) => {
    consoleWatch.current?.disconnect()
    consoleWatch.current = null
    if (!element) {
      setConsoleBox(null)
      return
    }
    const measure = () => {
      // Redondeado a saltos: que la consola crezca una línea no reencuadra el diagrama.
      const w = Math.ceil((element.offsetWidth + CONSOLE_MARGIN) / 20) * 20
      const h = Math.ceil((element.offsetHeight + CONSOLE_MARGIN) / 20) * 20
      setConsoleBox((known) => (known?.w === w && known.h === h ? known : { w, h }))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    consoleWatch.current = observer
    measure()
  }, [])
  /** La función que se está probando con otros datos (el id de su nodo): su panel está abierto. */
  const [trying, setTrying] = useState<string | null>(null)
  /** Lo último que dijo el JEV de qué pieza cubre cada parte de lo pedido. */
  const [judged, setJudged] = useState<{ key: string; by: (string | null)[] } | null>(null)
  /** Y lo que dijo del plan: qué etapa se ocupará de cada parte, antes de que esté escrita. */
  const [foreseen, setForeseen] = useState<{ key: string; by: (string | null)[] } | null>(null)
  /** El esbozo de lo último que se pidió sobre un lienzo vacío: sigue a la vista mientras se construye. */
  const [asked, setAsked] = useState<{ sketch: Sketch; kind: string | null } | null>(null)
  /** Lo que parece estar pidiendo, por lo que lleva dicho: su hueco se dibuja antes de que acabe la frase. */
  const [preview, setPreview] = useState<{ kind: string; text: string } | null>(null)
  const heardWords = useRef(0)
  /** Lo que ha dicho el JEV de cada cosa oída: si es una orden entera o está a medias. */
  const wholeness = useRef(new Map<string, number>())
  /** Dónde estaba la caja provisional cuando llegó la pieza de verdad: de ahí sale el marco que viaja. */
  const morphFrom = useRef<DOMRect | null>(null)
  /** La corrección que viene tras un «no, eso no»: se manda cuando lo deshecho ya se ve. */
  const afterUndo = useRef<string | null>(null)
  /** La línea de la función o la clase en la que hay que entrar en cuanto el programa la traiga. */
  const [enterLine, setEnterLine] = useState<number | null>(null)
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
  const onPreview = useRef<(kind: string, text: string) => void>(() => undefined)
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
      } else if (message.type === 'gists') {
        setGists(message.gists)
        setRan(message.run ?? null)
        setSettled((count) => count + 1)
      } else if (message.type === 'architecture') {
        setPlanned(message.modules)
      } else if (message.type === 'arched') {
        // Los papeles se guardan por el título de su módulo: así siguen valiendo si el programa cambia.
        try {
          const [modules] = JSON.parse(message.key) as [{ title: string }[]]
          const verdict = {
            roles: Object.fromEntries(
              modules.map((module, at) => [module.title, asRole(message.roles[at])]),
            ),
            shape: message.shape,
          }
          setArchVerdicts((known) => ({
            ...(Object.keys(known).length > 40 ? {} : known),
            [message.key]: verdict,
          }))
          setArchLast(verdict)
        } catch {
          // Una clave que no es la nuestra: no hay a quién aplicarla.
        }
      } else if (message.type === 'covered') {
        const verdict = { key: coverKey(message.parts, message.pieces), by: message.by }
        if (message.plan) setForeseen(verdict)
        else setJudged(verdict)
      } else if (message.type === 'preview') {
        // Si la frase está entera o a medias: el micrófono lo consulta antes de mandarla.
        if (message.complete !== undefined) {
          if (wholeness.current.size > 200) wholeness.current.clear()
          wholeness.current.set(sayKey(message.text), message.complete)
        }
        setPreview({ kind: message.kind, text: message.text })
        onPreview.current(message.kind, message.text)
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
  // Con los nodos recogidos de entrada, los de la lección no salen solos: se eligen.
  const suggested = features.foldInsights ? undefined : lesson?.show
  const insightIds = useMemo(
    () => insightChoice[file ?? ''] ?? suggested ?? [],
    [insightChoice, file, suggested],
  )
  // Se enciende o apaga sobre lo que había en ese momento (dos pulsaciones seguidas no se pisan).
  const toggleInsight = (id: InsightId) => {
    setInsightChoice((previous) => {
      const current = previous[file ?? ''] ?? suggested ?? []
      const now = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
      return { ...previous, [file ?? '']: INSIGHTS.filter((x) => now.includes(x)) }
    })
  }
  // Un guion que pide nodos para entender arranca la reproducción solo: si no, habría que darle antes al
  // botón «Paso a paso» para llegar a verlos (las tarjetas necesitan un paso concreto de la traza).
  const autoTraced = useRef<string | null>(null)
  useEffect(() => {
    if (version === null || !lesson?.show || lesson.show.length === 0) return
    // Con el reproductor recogido de entrada, no se graba nada hasta que se pide.
    if (features.foldInsights) return
    const key = `${file ?? ''}@${version}`
    if (autoTraced.current === key) return
    // Ya hay algo grabado (o en marcha) para esta versión: no hace falta pedirlo otra vez.
    if (recording && recording.version === version) return
    autoTraced.current = key
    post({ type: 'trace', version })
  }, [lesson, version, file, recording, features.foldInsights])
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
  // Si el programa falló al ejecutarlo, el paso en el que falló se marca en el diagrama: «línea 30» no le
  // dice nada a quien no lee el código; ver cuál es, sí.
  const failing =
    ran?.ended === 'error' && ran.line !== undefined && program
      ? ([...program.nodes]
          .filter(
            (n) => n.range && n.line <= (ran.line ?? 0) && (n.lineEnd ?? n.line) >= (ran.line ?? 0),
          )
          .sort((a, b) => b.line - a.line)[0]?.id ?? null)
      : null
  const stateOf = (id: string): NodeState => {
    if (id === failing) return 'error'
    const view = viewOf(id)
    return view ? NODE_STATE[view.state] : 'dormant'
  }
  const started =
    failing !== null || kernel !== 'stopped' || Object.values(runs).some((r) => r.state !== 'never')

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
  // Cada función de la que se sabe qué hace lleva su tarjeta (lo que entró → lo que salió): plegada, se lee
  // eso en vez de su diagrama. Solo mientras su texto sea el mismo del que salió la muestra.
  const gisted = useMemo(() => {
    if (!program || gists.length === 0) return source
    const hashes = new Map(
      [
        ...functionsIn(program),
        ...loopsIn(program),
        ...triesIn(program),
        ...classesIn(program),
        ...conditionsIn(program),
      ].map((fact) => [fact.id, fact.hash]),
    )
    const scenes = new Map(
      gists.flatMap((gist) => {
        const scene = hashes.get(gist.id) === gist.hash ? sampleScene(gist) : null
        return scene ? [[gist.id, scene] as const] : []
      }),
    )
    if (scenes.size === 0) return source
    return source.map((node) => {
      const scene = scenes.get(node.id)
      return scene ? { ...node, gist: scene } : node
    })
  }, [source, program, gists])
  const view = useProgramView(gisted, program?.edges ?? NO_EDGES, density, {
    flow: true,
    sections: program?.sections ?? NO_SECTIONS,
    // El primer nivel se lee como arquitectura. (Una lección va paso a paso por el código: sigue en columna.)
    architecture: lesson === null,
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
    // Mientras se le oye, el hueco de lo que está pidiendo: «Una función · que sume dos…».
    const guess = preview && preview.kind !== 'nada' ? (HEARD_LABELS[preview.kind] ?? null) : null
    // La caja de lo que se pidió sigue ahí mientras se piensa y se escribe: es la misma pieza, y dentro
    // se va leyendo lo que pasa. Solo se va cuando aparece el nodo de verdad (y se convierte en él).
    const drafting = guess !== null && preview !== null
    const busy = drafting
      ? (thinking ?? preview.text)
      : (thinking ?? (deciding ? 'Decidiendo qué hacer…' : null))
    const busyTitle = drafting ? guess : 'La IA está pensando'
    // Con el esbozo de lo pedido a la vista, en qué va la IA se lee en él: una caja más, colgada del
    // diagrama, diría lo mismo dos veces (y acababa tapada por el esbozo).
    if (busy !== null && asked === null) {
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
          label: busyTitle,
          viewer: {
            title: busyTitle,
            text: [busy],
            busy: true,
            // Mientras se le oye: no una nota, la caja de la pieza, rellenándose con lo que va diciendo.
            ...(drafting
              ? {
                  ghost: HEARD_GHOST[preview.kind],
                  draft: {
                    ...draftOf(preview.kind, preview.text),
                    ...(thinking === null ? {} : { does: thinking }),
                  },
                }
              : {}),
          },
        })
        links.push({ from: anchor, to: 'prysel:thinking', relation: 'transform' })
      }
    }
    return { nodes, links, busy }
  }, [
    program,
    view.nodes,
    view.representative,
    thinking,
    deciding,
    wanted,
    selected,
    preview,
    asked,
  ])
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
  /** Volver de la función que se ve: a la anterior del camino, o al programa. */
  const goBack = () => {
    const previous = view.trail[view.trail.length - 1]
    if (previous) view.descend(previous.id)
    else view.open(null)
  }
  /**
   * Lo que se le está oyendo o lo que lleva escrito (`was`: lo de antes). Al empezar, lo que se construye se
   * queda quieto; si no dijo nada, sigue. Con cada palabra nueva se manda lo que lleva: el JEV va adelantando
   * qué está pidiendo, y el lienzo lo esboza.
   */
  const attend = (heard: string | null, was: string | null) => {
    const words = heard === null ? 0 : heard.trim().split(/\s+/).length
    if ((heard !== null) !== (was !== null) || words !== heardWords.current) {
      post({ type: 'listening', on: heard !== null, ...(heard === null ? {} : { text: heard }) })
    }
    heardWords.current = words
    // Si no llegó a frase (un ruido, o lo borró), su hueco se va con ella.
    if (heard === null && order.phase !== 'deciding') setPreview(null)
  }
  /** Lo seleccionado, como líneas del programa: lo que eso escribió se resalta en la salida. */
  const picked = selected === null ? undefined : view.nodes.find((node) => node.id === selected)
  const litLines =
    picked?.line === undefined
      ? undefined
      : { from: picked.line, to: picked.lineEnd ?? picked.line }
  /** Lo que se dice de lo seleccionado en el chat: su nombre, para ofrecer qué hacer con ello. */
  const about = picked ? { label: picked.gist?.name ?? picked.label } : undefined
  /** Cuánto lleva lo que se está construyendo por etapas: las que ya tienen código, de las que hay. */
  const stages = program?.sections ?? NO_SECTIONS
  const pendingStages = program
    ? program.nodes.filter((node) => node.generating !== undefined).length
    : 0
  const building = order.phase === 'done' && order.building === true
  const progress =
    building && stages.length > 1
      ? { done: Math.max(0, stages.length - pendingStages), total: stages.length }
      : null
  // ── La arquitectura que se dibuja: la del análisis, con lo que el plan prometió de lo que aún no tiene
  // código y con lo que el JEV dijo de sus papeles y su forma. ──
  const generatingLines = useMemo(
    () => (program?.nodes ?? []).filter((node) => node.generating !== undefined).map((n) => n.line),
    [program],
  )
  /** Los módulos que aún no tienen código: su hueco sigue esperando. */
  const pendingModules = useMemo(
    () =>
      new Set(
        view.moduleFacts
          .filter((fact) =>
            generatingLines.some((line) => line >= fact.line && line <= fact.lineEnd),
          )
          .map((fact) => fact.id),
      ),
    [view.moduleFacts, generatingLines],
  )
  const plannedArchitecture = useMemo(
    () =>
      view.architecture && planned && pendingModules.size > 0
        ? withPlan(view.architecture, view.moduleFacts, planned, pendingModules)
        : view.architecture,
    [view.architecture, view.moduleFacts, planned, pendingModules],
  )
  /** Lo que se le pregunta al JEV: cada módulo con lo que su código deja ver, y las formas que cuadran. */
  const archQuestion = useMemo(() => {
    if (!plannedArchitecture) return null
    const modules = view.moduleFacts.map((fact) => ({
      title: fact.title,
      does: factsText(fact, pendingModules.has(fact.id)),
    }))
    // «Capas» cuadra siempre: es lo que queda cuando ninguna otra forma dice más, no una opción entre ellas.
    // Al JEV solo se le pregunta cuando hay varias formas de verdad entre las que elegir.
    const shapes = shapeCandidates(plannedArchitecture)
      .map((candidate) => candidate.shape)
      .filter((shape) => shape !== 'capas')
    return { key: JSON.stringify([modules, shapes]), modules, shapes }
  }, [plannedArchitecture, view.moduleFacts, pendingModules])
  useEffect(() => {
    if (archQuestion === null || archQuestion.key in archVerdicts) return
    // Se espera a que el programa deje de cambiar: mientras se escribe, cada pieza cambiaría la pregunta.
    const timer = window.setTimeout(() => {
      post({ type: 'arch', ...archQuestion })
    }, ARCH_WAIT_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [archQuestion, archVerdicts])
  const judgedArchitecture = useMemo(() => {
    if (!plannedArchitecture || archQuestion === null) return plannedArchitecture
    // Lo último que dijo el JEV de estos mismos módulos vale aunque el programa haya seguido cambiando: los
    // papeles van por título; la forma, solo si sigue siendo una de las que cuadran.
    const verdict = archVerdicts[archQuestion.key] ?? archLast
    if (!verdict) return plannedArchitecture
    const roles = Object.fromEntries(
      view.moduleFacts.map((fact) => [fact.id, verdict.roles[fact.title] ?? null]),
    )
    return withVerdict(plannedArchitecture, { roles, shape: verdict.shape })
  }, [plannedArchitecture, archQuestion, archVerdicts, archLast, view.moduleFacts])
  // Mientras se construye, la forma no baila: al pasar cada módulo de lo planeado a lo escrito hay ratos en
  // que el grafo se queda sin lo que la sostenía (ya no están las flechas del plan y aún no las del código).
  // Si la forma se cae a «capas» en uno de esos ratos, se mantiene la que había, con su ancla (por su título:
  // los módulos cambian de línea mientras se escribe). Al acabar, manda lo que haya.
  const constructing = order.phase === 'deciding' || building || thinking !== null || intro !== null
  const [held, setHeld] = useState<{ shape: ArchShape; anchor: string | null } | null>(null)
  const titleOf = (id: string | undefined) =>
    view.moduleFacts.find((fact) => fact.id === id)?.title ?? null
  const holding =
    !constructing || !judgedArchitecture
      ? null
      : judgedArchitecture.shape !== 'capas'
        ? { shape: judgedArchitecture.shape, anchor: titleOf(judgedArchitecture.anchor) }
        : held
  if (holding?.shape !== held?.shape || holding?.anchor !== held?.anchor) setHeld(holding)
  const heldArchitecture = useMemo(() => {
    if (!judgedArchitecture || judgedArchitecture.shape !== 'capas' || !held)
      return judgedArchitecture
    const anchor =
      held.anchor === null
        ? undefined
        : view.moduleFacts.find((fact) => fact.title === held.anchor)?.id
    // Una forma con ancla necesita que su ancla siga ahí.
    if (held.anchor !== null && anchor === undefined) return judgedArchitecture
    return {
      modules: judgedArchitecture.modules,
      links: judgedArchitecture.links,
      shape: held.shape,
      ...(anchor === undefined ? {} : { anchor }),
    }
  }, [judgedArchitecture, held, view.moduleFacts])
  // Y por encima de todo, lo que pasó al ejecutarlo: si el programa lo lleva un bucle, el diagrama cuenta su
  // vuelta (los pasos en su orden, lo que viaja entre ellos), no quién llama a quién. Mientras se construye
  // no: lo que se ejecutó era otro programa.
  const story = constructing ? undefined : ran?.story
  const architecture = useMemo(() => {
    if (!heldArchitecture || !story || !program) return heldArchitecture
    const told = moduleStory(story, program.nodes, view.moduleFacts)
    return told ? withStory(heldArchitecture, told, { calls: showCalls }) : heldArchitecture
  }, [heldArchitecture, story, program, view.moduleFacts, showCalls])
  // Los dos extremos de la arquitectura: dónde empieza el trabajo y qué sale al final.
  const outcome = useMemo(
    () =>
      ran && architecture && program
        ? outcomeOf(
            ran,
            view.moduleFacts,
            program.nodes.find(
              (node) => node.kind === 'abstraction.collapsed' && node.label === ran.entry,
            )?.line,
          )
        : null,
    [ran, architecture, program, view.moduleFacts],
  )
  const tryingGist =
    trying === null ? null : (gists.find((gist) => gist.id === trying && gist.sample) ?? null)
  /** Lleva la cámara a un elemento (si no se ve, el lienzo va a donde está: ver el efecto de más abajo). */
  /** Lo que se está escribiendo o diciendo ahora, esbozado. */
  const drawing = sketchOf(typed ?? hearing ?? '')
  // Cuando ya nadie trabaja en lo pedido (se acabó de construir, o no se pudo), su esbozo se retira: un
  // momento después, para que se vea completo.
  const working = order.phase === 'deciding' || building || thinking !== null || intro !== null
  useEffect(() => {
    if (asked === null || working) return
    const timer = window.setTimeout(() => {
      setAsked(null)
    }, SKETCH_LINGER_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [asked, working])
  // Las piezas que ya están escritas. Mientras se construye, una etapa es solo el plan: lo escrito son las
  // funciones y clases que existen. Al acabar, también vale la etapa (hay programas sin funciones).
  const programText = program?.source ?? ''
  // (Las listas se guardan por su contenido: que el programa cambie sin traer piezas nuevas no vuelve a
  // preguntar nada.)
  const titlesKey = JSON.stringify(asked === null ? [] : stages.map((stage) => stage.title))
  const titles = useMemo(
    () => (JSON.parse(titlesKey) as string[]).slice(0, MAX_COVER_PIECES),
    [titlesKey],
  )
  const writtenKey = JSON.stringify(
    asked === null ? [] : piecesOf(programText, building ? [] : titles).slice(0, MAX_COVER_PIECES),
  )
  const written = useMemo(() => JSON.parse(writtenKey) as string[], [writtenKey])
  // Qué pieza cubre cada parte lo dice el JEV, que entiende que «ver el total» es `calcular_suma`; mientras
  // llega su respuesta (o si no hay JEV), valen las palabras que comparten.
  const parts = asked?.sketch.parts
  const what = asked?.sketch.what
  useEffect(() => {
    if (parts === undefined || what === undefined || parts.length === 0 || written.length === 0) {
      return
    }
    const timer = window.setTimeout(() => {
      post({ type: 'cover', what, parts: parts.slice(0, MAX_COVER_PARTS), pieces: written })
    }, COVER_WAIT_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [parts, what, written])
  // Lo mismo con el plan, mientras se construye: qué etapa se ocupará de cada parte, antes de que exista su
  // código. Así una parte no espera como hueco mudo a que llegue su función.
  useEffect(() => {
    if (parts === undefined || what === undefined || parts.length === 0) return
    if (!building || titles.length === 0) return
    const timer = window.setTimeout(() => {
      post({
        type: 'cover',
        what,
        parts: parts.slice(0, MAX_COVER_PARTS),
        pieces: titles,
        plan: true,
      })
    }, COVER_WAIT_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [parts, what, titles, building])
  const goTo = (id: string) => {
    // Se selecciona lo que se ve: si el paso está dentro de algo plegado, eso que lo guarda.
    setSelected(shownIds.has(id) ? id : (view.representative(id) ?? id))
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
  const wantedFolded = wanted?.folded === true
  // Solo «nace» lo que se ve nacer: si lo que se señala es la tarjeta que lo guarda, esa ya estaba.
  const spotBorn = wanted?.born === true && spotId === wantedId
  const spotChange = wanted?.change
  const spotWide = wanted?.wide === true
  // La cámara puede quedarse en la caja que contiene la pieza (la función que se está escribiendo).
  const anchorLine = wanted?.anchor
  const anchorNode =
    anchorLine === undefined
      ? undefined
      : program?.nodes.find((n) => n.range && n.line === anchorLine)?.id
  const spotCamera =
    anchorNode === undefined || anchorNode === spotId
      ? undefined
      : shownIds.has(anchorNode)
        ? anchorNode
        : (view.representative(anchorNode) ?? undefined)
  const spotlight = useMemo(
    () =>
      spotId !== null && spotKey !== undefined
        ? {
            id: spotId,
            key: spotKey,
            ...(spotBorn ? { born: true } : {}),
            ...(spotChange ? { change: spotChange } : {}),
            ...(spotWide ? { wide: true } : {}),
            ...(spotCamera && spotCamera !== spotId ? { camera: spotCamera } : {}),
          }
        : null,
    [spotId, spotKey, spotBorn, spotChange, spotWide, spotCamera],
  )
  // Entrar en lo que se acaba de construir (una función, una clase), cuando el programa ya lo trae.
  const functions = view.functions
  const methods = view.methods
  useEffect(() => {
    if (enterLine === null || !program) return
    const head = program.nodes.find((n) => n.range && n.line === enterLine)
    if (!head) return
    if (functions.some((fn) => fn.id === head.id) || methods.some((fn) => fn.id === head.id)) {
      openView(head.id)
    }
    setEnterLine(null)
  }, [enterLine, program, functions, methods, openView])
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
  // La caja provisional se convierte en el nodo: un marco viaja de donde estaba ella a donde está él.
  useEffect(() => {
    const from = morphFrom.current
    if (from === null || spotId === null) return
    morphFrom.current = null
    const timer = setTimeout(() => {
      const node = document.querySelector(`.react-flow__node[data-id="${CSS.escape(spotId)}"]`)
      if (node) morph(from, node)
    }, 320)
    return () => {
      clearTimeout(timer)
    }
  }, [spotId, spotKey])
  // Lo que está a punto de quitarse se deshace en partículas: no desaparece de golpe.
  useEffect(() => {
    if (spotId === null || spotChange !== 'leaving' || reducedMotion) return
    const timer = setTimeout(() => {
      const node = document.querySelector(`.react-flow__node[data-id="${CSS.escape(spotId)}"]`)
      if (node) dissolve(node)
    }, 250)
    return () => {
      clearTimeout(timer)
    }
  }, [spotId, spotChange, spotKey, reducedMotion])
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
      // Lo que entra en una parte del plan que se deja plegada no la abre: se señala su tarjeta.
      ...(wantedId === undefined || wantedFolded ? [] : [wantedId]),
    ],
    [revealMoment, wantedId, wantedFolded],
  )
  useEffect(() => {
    reveal(revealIds)
  }, [revealIds, reveal])
  // Se va una vez por cada cosa que se quiere enseñar: después, el usuario puede irse a otra parte (abrir
  // otra función, volver al programa) sin que la vista lo devuelva a lo último que se construyó.
  const wentFor = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!program || wantedId === undefined || spotId !== null) return
    if (spotKey === undefined || wentFor.current === spotKey) return
    const node = program.nodes.find((n) => n.id === wantedId)
    if (!node) return
    wentFor.current = spotKey
    const fn = node.kind === 'abstraction.collapsed' ? node : enclosingFunctionNode(program, node)
    const home = fn ? homeOf(fn.id) : null
    if (home !== focusId) openView(home)
  }, [program, wantedId, spotId, spotKey, homeOf, focusId, openView])
  const sendOrder = (text: string, force?: Forced) => {
    if (version === null) return
    hush()
    const id = ++orderSeq.current
    lastOrder.current = text
    awaitingPaint.current = performance.now()
    paintArmed.current = false
    setOrder({ phase: 'deciding', text })
    // Lo pedido sobre un lienzo vacío se queda esbozado mientras se construye (ver `asked`).
    const drawn = program && program.nodes.length > 0 ? null : sketchOf(text)
    setJudged(null)
    setPlanned(null)
    setForeseen(null)
    setAsked(
      drawn && force === undefined
        ? {
            sketch: drawn,
            kind: preview && preview.kind !== 'nada' ? (HEARD_LABELS[preview.kind] ?? null) : null,
          }
        : null,
    )
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
  /**
   * Lo que se dice o se escribe en el chat. Antes que una orden puede ser la respuesta a una pregunta
   * pendiente («sí», «la segunda») o un «no, eso no», que deshace lo último y, si trae la corrección detrás,
   * la pide.
   */
  const hear = (text: string) => {
    if (order.phase === 'ask') {
      const answer = answerTo(
        text,
        order.options.map((option) => option.label),
      )
      if (answer === 'no') {
        orderSeq.current++
        setOrder({ phase: 'idle' })
        setChat((previous) => [
          ...previous.slice(-60),
          { id: Date.now(), role: 'user', text },
          { id: Date.now(), role: 'ai', text: 'Vale, lo dejo.', tone: 'muted' },
        ])
        return
      }
      const option = answer === null ? undefined : order.options[answer]
      if (option) {
        if (option.order) sendOrder(option.order)
        else sendOrder(lastOrder.current, option.force)
        return
      }
    }
    const rejected = rejection(text)
    if (rejected) {
      hush()
      orderSeq.current++
      setOrder({ phase: 'idle' })
      setPreview(null)
      setThinking(null)
      setChat((previous) => [
        ...previous.slice(-60),
        { id: Date.now(), role: 'user', text },
        { id: Date.now(), role: 'ai', text: 'Deshecho.', tone: 'muted' },
      ])
      // Detrás puede venir lo que sí se quería: se pide en cuanto lo deshecho ya se ve.
      afterUndo.current = rejected.then.split(' ').length >= 2 ? rejected.then : null
      post({ type: 'undoOrder' })
      return
    }
    sendOrder(text)
  }
  const sendLater = useRef<(text: string) => void>(() => undefined)
  useEffect(() => {
    sendLater.current = (text) => {
      sendOrder(text)
    }
  })
  // Lo deshecho ya se ve (llegó el programa de antes): ahora sí, la corrección.
  useEffect(() => {
    const next = afterUndo.current
    if (next === null || version === null) return
    afterUndo.current = null
    const timer = setTimeout(() => {
      sendLater.current(next)
    }, 80)
    return () => {
      clearTimeout(timer)
    }
  }, [version])
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
      if (
        directive.kind !== 'do' ||
        (directive.effect.type !== 'compose' && directive.effect.type !== 'modify')
      ) {
        setPreview(null)
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
        const action = effect.action
        const to =
          action.type === 'move' ? (action.into ?? action.after ?? action.before) : undefined
        const shown = directive.kind === 'do' ? directive.gesture : undefined
        const gone =
          action.type === 'delete' && !reducedMotion
            ? document.querySelector(`.react-flow__node[data-id="${CSS.escape(action.id)}"]`)
            : null
        if (gone) {
          // Borrar se ve: la pieza se deshace en partículas, y entonces se va del código.
          dissolve(gone)
          gone.setAttribute('data-moving', '')
          setTimeout(() => {
            act(action)
          }, 420)
        } else if (shown && !reducedMotion && action.type !== 'move') {
          // Envolver o duplicar: primero se ve lo que se le va a hacer; el código cambia al acabar el gesto.
          if (!shownIds.has(shown.id)) view.open(null)
          setWanted({ id: shown.id, key: ++spotSeq.current })
          setTimeout(
            () => {
              const piece = document.querySelector(
                `.react-flow__node[data-id="${CSS.escape(shown.id)}"]`,
              )
              const ms = piece ? gesture(shown.kind, piece) : 0
              setTimeout(() => {
                act(action)
              }, ms)
            },
            shownIds.has(shown.id) ? 550 : 900,
          )
        } else if (action.type !== 'move' || to === undefined || reducedMotion) act(action)
        else {
          // Mover se ve: su nombre viaja hasta el destino, y al llegar cambia el código. Si alguno de los
          // dos no está a la vista (se mira otra función), antes se sale al programa.
          const how =
            action.into !== undefined ? 'into' : action.after !== undefined ? 'after' : 'before'
          const hidden = !shownIds.has(action.id) || !shownIds.has(to)
          if (hidden) view.open(null)
          setWanted({ id: to, key: ++spotSeq.current, wide: true })
          const find = (id: string) =>
            document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
          setTimeout(
            () => {
              const source = find(action.id)
              const target = find(to)
              const flight = source && target ? flyNode(source, target, how) : { ms: 0 }
              setTimeout(() => {
                act(action)
              }, flight.ms)
            },
            hidden ? 900 : 550,
          )
        }
      } else if (effect.type === 'undo' || effect.type === 'redo') post({ type: effect.type })
      else if (effect.type === 'modify' && directive.kind === 'do' && directive.gesture) {
        // Juntar o extraer: el código lo reescribe la IA (tarda); mientras, se ve qué se va a hacer.
        const shown = directive.gesture
        if (!reducedMotion) {
          // Las piezas tienen que estar a la vista las dos: si se mira otra cosa (una de ellas por
          // dentro), antes se sale al programa.
          const hidden =
            !shownIds.has(shown.id) || (shown.to !== undefined && !shownIds.has(shown.to))
          if (hidden) view.open(null)
          else setWanted({ id: shown.id, key: ++spotSeq.current, wide: true })
          setTimeout(
            () => {
              const find = (id: string) =>
                document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
              const piece = find(shown.id)
              if (piece) gesture(shown.kind, piece, shown.to === undefined ? null : find(shown.to))
            },
            hidden ? 950 : 550,
          )
        }
      } else if (effect.type === 'run') run(effect.ids)
      else if (effect.type === 'trace') post({ type: 'trace', version })
      else if (effect.type === 'fold') view.enter(effect.id)
      if (directive.kind === 'do' && directive.home) {
        // «Ver el programa principal»: se sale de lo que se estuviera viendo.
        view.open(null)
      } else if (directive.focus !== undefined) {
        const seen = directive.focus
        // «Ver la clase Animal»: si es algo con interior, se entra; si no, la cámara va a ello.
        if (
          directive.kind === 'do' &&
          directive.intent === 'enfocar' &&
          (view.functions.some((fn) => fn.id === seen) || view.methods.some((fn) => fn.id === seen))
        ) {
          view.open(seen)
        } else goTo(seen)
      }
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
    // Mientras se le oye hablar de algo que ya existe («vamos a cambiar la función sumar»), se señala, a la
    // espera de saber qué quiere hacer con ello.
    onPreview.current = (kind, text) => {
      if (kind !== 'cambio' && kind !== 'explicacion') return
      const said = text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
      const named = [...view.functions, ...view.methods].find((fn) =>
        said.includes((fn.name.split('.').pop() ?? fn.name).toLowerCase()),
      )
      if (named && wanted?.id !== named.id) setWanted({ id: named.id, key: ++spotSeq.current })
    }
    onStep.current = (message) => {
      // Llega la pieza de verdad: la caja provisional se va… convirtiéndose en ella.
      if (preview !== null) {
        morphFrom.current = document.querySelector('.ghost-box')?.getBoundingClientRect() ?? null
        setPreview(null)
      }
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
        ...(message.folded ? { folded: true } : {}),
        ...(message.anchor === undefined ? {} : { anchor: message.anchor }),
        ...(message.mark?.length ? { mark: message.mark } : {}),
      })
    }
    onGenerated.current = (message) => {
      if (message.done) {
        setThinking(null)
        setCaption(null)
        setIntro(null)
        setPreview(null)
        // Lo construido es una función o una clase: la vista entra en ella, que es donde se va a seguir.
        if (message.enter !== undefined) setEnterLine(message.enter)
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
      // Un comentario al margen: subtítulo, y voz solo si no pisa a otra frase.
      if (message.aside) {
        if (voice && !window.speechSynthesis?.speaking) speak(message.text, 'es', false, heard)
        else heard(false)
        setCaption(message.text)
        return
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
            {view.focus !== null && (
              <Button
                icon="undo"
                title="Volver a donde estabas antes de entrar aquí"
                onClick={goBack}
              >
                Volver
              </Button>
            )}
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
        <main
          className="relative min-h-0 min-w-0 flex-1"
          data-hearing={hearing !== null ? '' : undefined}
        >
          {/* Le estamos oyendo: se ve, grande, y con lo que va diciendo. Lo que se construía está quieto. */}
          {hearing !== null && (
            <div className="canvas-hearing" role="status" aria-live="polite">
              <span className="canvas-hearing__dot" aria-hidden />
              <span className="canvas-hearing__label">Te escucho</span>
              <span className="canvas-hearing__text">{hearing}</span>
            </div>
          )}
          {/* La pestaña «Consultas» va encima del diagrama, que sigue montado (no pierde su cámara). */}
          {tab === 'calls' && (
            <div className="calls-layer">
              {features.chat && (
                <div className="calls-layer__back">
                  <Button
                    onClick={() => {
                      setTab('canvas')
                    }}
                  >
                    Volver al diagrama
                  </Button>
                </div>
              )}
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
                onGistEdit={setTrying}
                architecture={architecture}
                avoid={consoleBox}
                result={outcome?.result ?? null}
                start={outcome?.start ?? null}
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
                settle={settled}
                // Mientras se construye se ve el conjunto: la cámara no persigue cada pieza que nace.
                follow={!building}
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
            <EmptyState
              // Lo que se teclea ya se lee en su campo: repetirlo bajo el esbozo no dice nada (con la voz sí,
              // que no tiene dónde verse escrita).
              thinking={
                typed !== null &&
                extras.busy != null &&
                (typed.trim().startsWith(extras.busy.trim()) ||
                  extras.busy.trim().startsWith(typed.trim()))
                  ? null
                  : extras.busy
              }
              title={
                thinking === null && preview && preview.kind !== 'nada'
                  ? (HEARD_LABELS[preview.kind] ?? null)
                  : null
              }
              intro={intro}
              chat={features.chat === true}
              sketch={drawing ?? asked?.sketch ?? null}
              kind={
                drawing === null && asked
                  ? asked.kind
                  : preview && preview.kind !== 'nada'
                    ? (HEARD_LABELS[preview.kind] ?? null)
                    : null
              }
              // Ya enviado: el esbozo se queda mientras se decide y se piensa el plan, diciendo en qué va.
              sent={
                drawing === null && asked ? (intro ?? thinking ?? 'Decidiendo qué hacer…') : null
              }
            />
          )}
          {/* El esbozo de lo pedido sigue a la vista mientras se construye, y se va llenando: cada parte
              se marca con la pieza del programa que la cubre, en cuanto existe. */}
          {asked && program && program.nodes.length > 0 && (
            <div className="canvas-float sketch-pin">
              <SketchCard
                sketch={asked.sketch}
                kind={asked.kind}
                filled={coverOf(
                  filledBy(asked.sketch, written),
                  verdictFor(judged, asked.sketch.parts, written),
                  written,
                )}
                planned={coverOf(
                  filledBy(asked.sketch, titles),
                  verdictFor(foreseen, asked.sketch.parts, titles),
                  titles,
                )}
                hint={thinking}
                pinned
              />
            </div>
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
                <>
                  {(view.functions.length > 0 ||
                    view.methods.length > 0 ||
                    view.focus !== null) && (
                    <div className="canvas-float canvas-float--trail" data-at="top-left">
                      {view.focus !== null && (
                        <Button
                          icon="undo"
                          title="Volver a donde estabas antes de entrar aquí"
                          onClick={goBack}
                        >
                          Volver
                        </Button>
                      )}
                      <FunctionMenu
                        functions={view.functions}
                        methods={view.methods}
                        focus={view.focus}
                        trail={view.trail}
                        onOpen={view.open}
                        onCrumb={view.descend}
                      />
                    </div>
                  )}
                  {/* Sin barra de herramientas, el paso a paso se pide desde el lienzo: el reproductor no
                      está a la vista hasta entonces. */}
                  {(!replay || features.calls) && (
                    <div className="canvas-float canvas-float--row" data-at="top-right">
                      {!replay && (
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
                      )}
                      {/* Sin pestañas (no hay barra de herramientas), las consultas se abren desde aquí. */}
                      {features.calls && (
                        <Button
                          title="Lo que se le pregunta a cada modelo (la IA que redacta y el JEV que decide) y lo que contesta"
                          onClick={() => {
                            setTab('calls')
                          }}
                        >
                          Consultas{calls.length > 0 ? ` ${calls.length}` : ''}
                          {calls.some((call) => call.status === 'running') ? ' ·' : ''}
                        </Button>
                      )}
                    </div>
                  )}
                </>
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
              {/* Cuánto lleva lo que se construye: las partes del plan que ya tienen código. */}
              {progress && (
                <div
                  className="build-progress"
                  role="progressbar"
                  aria-label="Lo que lleva construido"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.done}
                >
                  <span
                    className="build-progress__bar"
                    style={{ width: `${(progress.done / progress.total) * 100}%` }}
                  />
                  <span className="build-progress__text">
                    {progress.done} de {progress.total} partes
                  </span>
                </div>
              )}
              {/* Cómo leer la arquitectura: qué forma tiene y qué dice cada flecha. */}
              {architecture && program.nodes.length > 0 && (
                <div className="canvas-float arch-legend" role="note">
                  <span className="arch-legend__shape" title={SHAPE_WHY[architecture.shape]}>
                    {SHAPE_NAMES[architecture.shape]}
                  </span>
                  {architecture.links.some((link) => link.kind === 'data') && (
                    <span className="arch-legend__key" data-kind="data">
                      le pasa un dato
                    </span>
                  )}
                  {architecture.links.some((link) => link.kind === 'next') && (
                    <span className="arch-legend__key" data-kind="next">
                      luego
                    </span>
                  )}
                  {architecture.links.some((link) => link.kind === 'call') && (
                    <span className="arch-legend__key" data-kind="call">
                      usa a
                    </span>
                  )}
                  {architecture.order !== undefined && (
                    // Contado por su ejecución, quién llama a quién sobra… salvo para quien quiera verlo.
                    <button
                      type="button"
                      className="arch-legend__toggle"
                      aria-pressed={showCalls}
                      onClick={() => {
                        setShowCalls(!showCalls)
                      }}
                    >
                      quién llama a quién
                    </button>
                  )}
                  {architecture.links.some((link) => link.planned) && (
                    <span className="arch-legend__key" data-kind="planned">
                      planeado
                    </span>
                  )}
                </div>
              )}
              {/* Probar una función con otros datos: su tarjeta cambia con lo que de verdad pasa. */}
              {tryingGist && (
                <div className="canvas-float try-panel">
                  <TryPanel
                    // Otra función, o su muestra cambió por fuera: los campos empiezan de lo que hay.
                    key={`${tryingGist.id}:${tryingGist.sample?.call ?? ''}`}
                    gist={tryingGist}
                    onTry={(call) => {
                      post({ type: 'tryCall', id: tryingGist.id, call })
                    }}
                    onClose={() => {
                      setTrying(null)
                    }}
                  />
                </div>
              )}
              {/* Lo que el programa saca por pantalla: a la vista mientras se construye. */}
              {ran && program && program.nodes.length > 0 && (
                <div className="canvas-float" data-at="bottom-right" ref={watchConsole}>
                  <RunPanel
                    run={ran}
                    lit={litLines}
                    quiet={outcome?.result != null && ran.asks !== true && ran.ended === 'done'}
                    onPlay={(answers, fresh) => {
                      post({ type: 'play', answers, ...(fresh ? { fresh: true } : {}) })
                    }}
                    onWake={(idle) => {
                      // Nadie lo arranca: se le añade su arranque. Trabaja sin enseñar: se le pide a la IA.
                      if (idle === 'inert') post({ type: 'launch' })
                      else sendOrder('Haz que el programa enseñe su resultado en pantalla')
                    }}
                    onPick={(line) => {
                      // El paso más interior que abarca esa línea; si está plegado, lo que lo guarda.
                      const node = [...program.nodes]
                        .filter((n) => n.range && n.line <= line && (n.lineEnd ?? n.line) >= line)
                        .sort((a, b) => b.line - a.line)[0]
                      if (node) goTo(node.id)
                    }}
                  />
                </div>
              )}
              {features.orders && !features.chat && (
                <div className="canvas-float" data-at="bottom-center">
                  <CommandBar
                    state={order}
                    voice={voice}
                    onToggleVoice={() => {
                      if (voice) hush()
                      vscode.setState({ ...saved(), voice: !voiceOn } satisfies SavedState)
                      setVoice(!voiceOn)
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
            extras={
              <InsightToggles
                ids={insightIds}
                onToggle={toggleInsight}
                folded={features.foldInsights === true}
              />
            }
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
          about={about}
          // Con el lienzo vacío se propone algo que construir; con un programa delante, qué hacer con él.
          suggestions={
            (program?.nodes.length ?? 0) === 0
              ? (features.starters ?? features.suggestions ?? [])
              : (features.suggestions ?? [])
          }
          onSubmit={(text) => {
            hear(text)
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
            vscode.setState({ ...saved(), voice: !voiceOn } satisfies SavedState)
            setVoice(!voiceOn)
          }}
          onSettings={() => {
            post({ type: 'pickModel' })
          }}
          onTyping={hush}
          onMic={(open) => {
            if (open) hush()
            setMicOpen(open)
            if (!open) setHearing(null)
          }}
          judged={(heard) => wholeness.current.get(sayKey(heard))}
          onHearing={(heard) => {
            attend(heard, hearing)
            setHearing(heard)
          }}
          onDraft={(written) => {
            attend(written, typed)
            setTyped(written)
          }}
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

/** Lo dicho, para buscarlo: sin mayúsculas, signos ni espacios de más. */
const sayKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Con qué aspecto se dibuja el hueco de cada cosa que se puede pedir. */
const HEARD_GHOST: Record<string, NonNullable<ViewerContent['ghost']>> = {
  funcion: 'function',
  clase: 'class',
  bucle: 'loop',
  decision: 'condition',
  variable: 'value',
  lista: 'list',
  programa: 'program',
  cambio: 'change',
  explicacion: 'talk',
}

/** Cómo se nombra lo que el usuario parece estar pidiendo mientras aún habla. */
const HEARD_LABELS: Record<string, string> = {
  funcion: 'Una función',
  clase: 'Una clase',
  bucle: 'Un bucle',
  decision: 'Una decisión',
  variable: 'Un dato',
  lista: 'Una lista',
  programa: 'Un programa',
  cambio: 'Un cambio',
  explicacion: 'Una explicación',
}

/** El aire entre la consola y el diagrama (su separación del borde, y un poco más). */
const CONSOLE_MARGIN = 28

/** Cómo se dice cada forma de la arquitectura, y por qué se eligió. */
const SHAPE_NAMES: Record<ArchShape, string> = {
  capas: 'Por capas',
  tuberia: 'Una tubería',
  centro: 'Un centro que reparte',
  ciclo: 'Un ciclo',
  embudo: 'Un embudo',
  abanico: 'Un abanico',
}
const SHAPE_WHY: Record<ArchShape, string> = {
  capas: 'Arriba, quien manda; en medio, lo que entra, se hace y sale; abajo, lo que se guarda.',
  tuberia: 'Cada parte le pasa su resultado a la siguiente.',
  centro: 'Un módulo reparte el trabajo: usa a uno u otro de los demás.',
  ciclo: 'Un bucle que en cada vuelta usa a los demás, uno tras otro.',
  embudo: 'Varias partes le pasan lo suyo a una, que lo junta.',
  abanico: 'Lo que guarda un módulo lo usan varias partes independientes.',
}

/** Lo que dijo el JEV de una arquitectura: el papel de cada módulo (por su título) y la forma. */
interface ArchVerdict {
  roles: Record<string, ModuleRole | null>
  shape: string | null
}
const asRole = (role: string | null | undefined): ModuleRole | null =>
  MODULE_ROLES.find((known) => known === role) ?? null
/** Cuánto se espera a que el programa deje de cambiar antes de preguntarle al JEV por su arquitectura. */
const ARCH_WAIT_MS = 500

/** Cuánto se espera a que el programa deje de cambiar antes de preguntar al JEV qué cubre cada parte. */
const COVER_WAIT_MS = 350
const coverKey = (parts: readonly string[], pieces: readonly string[]) =>
  JSON.stringify([parts, pieces])

/**
 * Lo que dijo el JEV, si vale para estas partes. Un «ninguna» dicho de unas piezas que ya han cambiado no
 * cuenta: puede haber llegado la que faltaba.
 */
function verdictFor(
  verdict: { key: string; by: (string | null)[] } | null,
  parts: readonly string[],
  pieces: readonly string[],
): (string | null)[] | null {
  if (verdict?.by.length !== parts.length) return null
  return verdict.key === coverKey(parts, pieces)
    ? verdict.by
    : verdict.by.map((piece) => (piece === '' ? null : piece))
}

/** Cuánto se queda el esbozo de lo pedido cuando ya está construido: lo justo para verlo completo. */
const SKETCH_LINGER_MS = 3200

/**
 * El esbozo de lo que se pide: la cosa, arriba; debajo, cada parte que la frase nombra, como el hueco de una
 * pieza que vendrá. Con `filled`, cada hueco que el programa ya cubre lleva su marca y el nombre de la pieza.
 */
function SketchCard({
  sketch,
  kind,
  hint = null,
  filled,
  planned,
  pinned = false,
}: {
  sketch: Sketch
  kind: string | null
  hint?: string | null
  filled?: (string | null)[]
  /** La etapa del plan que cubrirá cada parte, aún sin escribir: se anuncia, pero no se da por hecha. */
  planned?: (string | null)[]
  pinned?: boolean
}) {
  const done = filled?.filter((piece) => piece !== null).length ?? 0
  return (
    <div className="sketch" data-pinned={pinned ? '' : undefined}>
      <div className="sketch__what">
        <span className="sketch__kind">{kind ?? 'Lo que pides'}</span>
        <span className="sketch__name">{sketch.what}</span>
        {filled && sketch.parts.length > 0 && (
          <span className="sketch__count">
            {done} de {sketch.parts.length}
          </span>
        )}
      </div>
      {sketch.parts.length > 0 && (
        <ol className="sketch__parts">
          {sketch.parts.map((part, index) => {
            const piece = filled?.[index] ?? null
            const plan = piece === null ? (planned?.[index] ?? null) : null
            return (
              // La clave es su sitio: una parte que se sigue escribiendo crece sin volver a entrar.
              <li
                key={index}
                className="sketch__part"
                data-filled={piece ? '' : undefined}
                data-planned={plan ? '' : undefined}
              >
                <span className="sketch__n" aria-hidden>
                  {piece ? '✓' : index + 1}
                </span>
                <span className="sketch__text">{part}</span>
                {(piece ?? plan) && <span className="sketch__piece">{piece ?? plan}</span>}
              </li>
            )
          })}
        </ol>
      )}
      {hint !== null && <p className="sketch__hint">{hint}</p>}
    </div>
  )
}

function EmptyState({
  thinking,
  title = null,
  intro,
  chat,
  sketch = null,
  kind = null,
  sent = null,
}: {
  /** Ya se envió: en qué va quien lo construye. El esbozo no se quita mientras tanto. */
  sent?: string | null
  thinking: string | null
  /** Si se sabe qué se está pidiendo (aún se le oye), su nombre en vez de «La IA está pensando». */
  title?: string | null
  intro: string | null
  chat: boolean
  /** Lo que se está pidiendo, tal como se va escribiendo o diciendo: la cosa y las partes que ya nombra. */
  sketch?: Sketch | null
  /** Qué clase de cosa es, si el JEV ya lo ha dicho («Un programa», «Una función»…). */
  kind?: string | null
}) {
  // El comentario de entrada: lo que se va a hacer, mientras aún no hay nada dibujado.
  if (sketch !== null && sent !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6" role="status" aria-live="polite">
        <SketchCard sketch={sketch} kind={kind} hint={sent} />
      </div>
    )
  }
  if (intro !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6" role="status">
        <p className="intro-card">{intro}</p>
      </div>
    )
  }
  // Se está escribiendo (o diciendo) lo que se quiere: el lienzo lo va esbozando antes de mandarlo. La cosa,
  // arriba; debajo, cada parte que la frase ya nombra, como el hueco de una pieza que vendrá.
  if (sketch !== null && intro === null && (thinking === null || kind !== null)) {
    return (
      <div className="flex h-full items-center justify-center p-6" role="status" aria-live="polite">
        <SketchCard
          sketch={sketch}
          kind={kind}
          hint={thinking ?? 'Sigue escribiendo, o pulsa Intro: lo construyo aquí.'}
        />
      </div>
    )
  }
  // Aún no hay diagrama, pero la IA ya está en ello: se dice aquí, donde va a aparecer.
  if (thinking !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6" role="status">
        <div className="thinking-card" data-preview={title ? '' : undefined}>
          {title ?? 'La IA está pensando'} · {thinking}
        </div>
      </div>
    )
  }
  if (chat) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center" role="status">
        <div className="max-w-xs">
          <p className="text-base text-ink">¿Qué quieres construir?</p>
          <p className="mt-2 text-sm leading-6 text-ink-faint">
            Dilo con tus palabras, abajo o con el micrófono: «un juego de adivinar el número»,
            «llevar la cuenta de mis gastos». Verás el programa crecer aquí, y funcionar. También
            puedes pedir que te enseñe un tema.
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
