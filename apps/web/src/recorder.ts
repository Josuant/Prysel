/**
 * Grabar una explicación para revisarla después: qué se vio y cuándo.
 *
 * Con la opción activada, cada orden que se le da a la IA se graba desde que se manda hasta que deja de
 * pasar nada, y al acabar se descargan dos archivos con el mismo nombre:
 *
 * - **el vídeo** de la pestaña (`.webm`), si el navegador deja capturarla (en el móvil no suele);
 * - **la línea de tiempo** (`.json`): cada mensaje entre la página y el lienzo —un paso que aparece, una
 *   frase que se dice, una consulta a un modelo que empieza o acaba— con el instante en que pasó. Es lo que
 *   permite medir (cuánto se tardó en enseñar lo primero, cuánto hueco hubo entre pieza y pieza) en vez de
 *   opinar mirando el vídeo.
 *
 * El permiso para capturar la pestaña se pide una vez, al activar la opción (el navegador solo lo da tras
 * un gesto del usuario); la captura queda abierta y cada grabación la aprovecha.
 */

/** Sin nada nuevo ni nada pendiente durante este tiempo, la explicación se da por terminada. */
const IDLE_MS = 7000
/**
 * Con algo pendiente (una consulta sin contestar, una construcción sin acabar, una frase a medio decir) se
 * sigue grabando aunque no pase nada… hasta este tope de silencio: por si algo se quedó colgado.
 */
const STALL_MS = 120_000
/** Y pase lo que pase, una grabación no dura más que esto. */
const MAX_MS = 10 * 60_000

interface Moment {
  /** Milisegundos desde que empezó la grabación. */
  t: number
  /** `in`: del lienzo a la página (lo que hace el usuario). `out`: de la página al lienzo (lo que se ve). */
  dir: 'in' | 'out'
  type: string
  [detail: string]: unknown
}

const clip = (text: unknown, max = 160) =>
  typeof text === 'string' ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : undefined

/** Lo que importa de un mensaje para la línea de tiempo: qué fue, sin el programa entero ni las claves. */
function digest(message: Record<string, unknown>): Record<string, unknown> {
  const pick = (...keys: string[]) =>
    Object.fromEntries(
      keys.filter((key) => message[key] !== undefined).map((key) => [key, message[key]]),
    )
  switch (message.type) {
    case 'update': {
      const program = message.program as { nodes?: unknown[]; source?: string } | null
      return { nodes: program?.nodes?.length ?? 0, chars: program?.source?.length ?? 0 }
    }
    case 'step':
      return {
        ...pick('gen', 'index', 'line', 'effect', 'wide', 'seq', 'mark', 'folded'),
        say: clip(message.say),
      }
    case 'say':
      return { ...pick('focus', 'seq'), text: clip(message.text) }
    case 'progress':
      return { ...pick('gen'), text: clip(message.text) }
    case 'generated':
      return {
        ...pick('gen', 'ok', 'done', 'line', 'jevMs'),
        say: clip(message.say),
        error: clip(message.error),
      }
    case 'decision':
      return { decision: clip(JSON.stringify(message.decision ?? message), 400) }
    case 'call': {
      const entry = (message.entry ?? {}) as Record<string, unknown>
      return {
        id: entry.id,
        kind: entry.kind,
        model: entry.model,
        status: entry.status,
        ms: entry.ms,
        chars: typeof entry.text === 'string' ? entry.text.length : undefined,
        error: clip(entry.error),
      }
    }
    case 'command':
      return { text: clip(message.text, 400) }
    case 'listening':
      return pick('on')
    case 'spoken':
      return pick('seq', 'spoke')
    default:
      return {}
  }
}

/** Los mensajes que son parte de una explicación: mientras sigan llegando, no ha terminado. */
const ALIVE = new Set([
  'step',
  'say',
  'progress',
  'generated',
  'decision',
  'call',
  'spoken',
  'update',
  'listening',
])

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export class SessionRecorder {
  private on = false
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private moments: Moment[] | null = null
  private began = 0
  private order = ''
  private idle: ReturnType<typeof setTimeout> | null = null
  /** Lo que está en marcha: mientras quede algo, la explicación no ha terminado. */
  private calls = new Set<unknown>()
  private gens = new Set<string>()
  private speech = new Set<number>()
  private last = 0
  private limit: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<() => void>()

  /** Si la opción está activada, y si además hay vídeo (o solo línea de tiempo). */
  get state(): { on: boolean; video: boolean; recording: boolean } {
    return { on: this.on, video: this.stream !== null, recording: this.moments !== null }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed() {
    for (const listener of this.listeners) listener()
  }

  /**
   * Activa la grabación. Hay que llamarla desde un gesto del usuario (un clic): pide permiso para capturar
   * la pestaña. Si no se concede (o el navegador no sabe), queda activada igual, solo con línea de tiempo.
   */
  async arm(): Promise<void> {
    this.on = true
    try {
      const media = navigator.mediaDevices as MediaDevices | undefined
      if (media?.getDisplayMedia) {
        this.stream = await media.getDisplayMedia({
          video: { frameRate: 30 },
          audio: false,
          // Chrome: ofrece esta misma pestaña lo primero.
          preferCurrentTab: true,
        } as DisplayMediaStreamOptions)
        // Si el usuario deja de compartir desde el navegador, se sigue solo con la línea de tiempo.
        this.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
          this.stream = null
          this.changed()
        })
      }
    } catch {
      this.stream = null
    }
    this.changed()
  }

  /** Desactiva la grabación y suelta la captura de la pestaña. Lo que se estuviera grabando se guarda. */
  disarm() {
    this.finish()
    this.on = false
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.changed()
  }

  /** Un mensaje pasó entre la página y el lienzo. Una orden empieza una grabación; el silencio la acaba. */
  note(dir: 'in' | 'out', value: unknown) {
    if (!this.on || typeof value !== 'object' || value === null) return
    const message = value as Record<string, unknown>
    const type = typeof message.type === 'string' ? message.type : ''
    if (dir === 'in' && type === 'command' && this.moments === null) {
      this.begin(typeof message.text === 'string' ? message.text : '')
    }
    if (this.moments === null) return
    this.moments.push({
      t: Math.round(performance.now() - this.began),
      dir,
      type,
      ...digest(message),
    })
    this.track(dir, type, message)
    if (ALIVE.has(type) || type === 'command') {
      this.last = performance.now()
      this.rest()
    }
  }

  private begin(order: string) {
    this.moments = []
    this.calls.clear()
    this.gens.clear()
    this.speech.clear()
    this.chunks = []
    this.began = performance.now()
    this.order = order
    if (this.stream && typeof MediaRecorder !== 'undefined') {
      try {
        const recorder = new MediaRecorder(this.stream, { videoBitsPerSecond: 2_500_000 })
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0) this.chunks.push(event.data)
        })
        recorder.start(1000)
        this.recorder = recorder
      } catch {
        this.recorder = null
      }
    }
    this.limit = setTimeout(() => {
      this.finish()
    }, MAX_MS)
    this.changed()
  }

  /** Aún pasa algo: la cuenta atrás del silencio vuelve a empezar. */
  private rest() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      // Entre el plan y el código, o mientras un modelo piensa, no pasa nada a la vista: eso no es el final.
      const pending = this.calls.size + this.gens.size + this.speech.size > 0
      if (pending && performance.now() - this.last < STALL_MS) this.rest()
      else this.finish()
    }, IDLE_MS)
  }

  /** Lleva la cuenta de lo que hay en marcha: consultas a modelos, construcciones y frases diciéndose. */
  private track(dir: 'in' | 'out', type: string, message: Record<string, unknown>) {
    const { gen, seq } = message
    if (dir === 'out' && type === 'call') {
      const entry = (message.entry ?? {}) as { id?: unknown; status?: unknown }
      if (entry.status === 'running') this.calls.add(entry.id)
      else this.calls.delete(entry.id)
    }
    if (dir === 'out' && typeof gen === 'string') {
      if (type === 'generated') this.gens.delete(gen)
      else if (type === 'step' || type === 'progress') this.gens.add(gen)
    }
    // Lo que no es una construcción (generar la lección) avisa de que acabó con una frase suelta.
    if (dir === 'out' && type === 'say' && typeof seq !== 'number') this.gens.clear()
    if (typeof seq === 'number') {
      if (dir === 'in' && type === 'spoken') this.speech.delete(seq)
      else if (dir === 'out' && (type === 'step' || type === 'say')) this.speech.add(seq)
    }
  }

  /** Termina la grabación en marcha (si la hay) y descarga el vídeo y la línea de tiempo. */
  finish() {
    const moments = this.moments
    if (moments === null) return
    this.moments = null
    if (this.idle) clearTimeout(this.idle)
    if (this.limit) clearTimeout(this.limit)
    this.idle = this.limit = null
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const name = `prysel-${stamp}`
    const timeline = {
      order: this.order,
      at: new Date().toISOString(),
      // El final del silencio que la dio por terminada no es parte de la explicación.
      ms: moments.at(-1)?.t ?? 0,
      video: this.recorder !== null,
      screen: { width: window.innerWidth, height: window.innerHeight },
      agent: navigator.userAgent,
      moments,
    }
    download(
      new Blob([JSON.stringify(timeline, null, 2)], { type: 'application/json' }),
      `${name}.json`,
    )
    const recorder = this.recorder
    this.recorder = null
    if (recorder) {
      recorder.addEventListener('stop', () => {
        download(new Blob(this.chunks, { type: recorder.mimeType || 'video/webm' }), `${name}.webm`)
        this.chunks = []
      })
      recorder.stop()
    }
    this.changed()
  }
}

export const recorder = new SessionRecorder()
