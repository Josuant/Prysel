import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useEffect, useRef } from 'react'

/**
 * **La pantalla del programa, como un nodo.** Lo que el programa enseña para usarlo de verdad (con su módulo
 * `pantalla`): su título, sus botones (se pulsan), sus teclas, lo que dibuja y lo que escribe. Lo que suena
 * no se ve aquí: suena. Va a la salida del diagrama, antes que el resultado: es lo que se usa.
 *
 * El nodo no sabe de programas: enseña lo que le dan y avisa de lo que se pulsa.
 */

export type ScreenShapeView =
  | { shape: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { shape: 'circle'; x: number; y: number; r: number; color: string }
  | { shape: 'line'; x: number; y: number; x2: number; y2: number; color: string; width: number }
  | { shape: 'text'; x: number; y: number; text: string; color: string; size: number }

export interface ScreenView {
  /** `idle`: aún no se ha puesto en marcha (se espera a «Empezar», que además deja sonar). */
  phase: 'idle' | 'loading' | 'running' | 'failed'
  title: string | null
  lines: readonly string[]
  buttons: readonly { id: number; label: string; color?: string }[]
  /** Las teclas que usa, ya dichas para leerlas («a», «espacio», «←»). */
  keys: readonly string[]
  canvas: { w: number; h: number; bg: string; shapes: readonly ScreenShapeView[] } | null
  /** Partes del lienzo que se pulsan; y si pulsar en cualquier otro sitio también hace algo. */
  zones?: readonly { id: number; x: number; y: number; w: number; h: number }[]
  touch?: number | null
  error: { message: string; line: number | null } | null
}

export interface ScreenPanel {
  view: ScreenView
  /** Una pulsación: de un botón, una zona del lienzo o (con dónde, `[x, y]`) del lienzo entero. */
  onPress: (id: number, args?: readonly number[]) => void
  /** Volver a arrancarlo de cero (o ponerlo en marcha la primera vez). */
  onRestart: () => void
}

const PAD = 12
const HEAD = 34
const LINE = 18
const BUTTON_H = 40
const GAP = 6
const MAX_LINES = 4
/** Lo que miden la fila de las teclas, el aviso de un fallo y el relleno de arriba y abajo del cuerpo. */
const KEYS_H = 20
const ERROR_H = 44
const BODY_PAD = 22

/** Lo ancho que es la pantalla: la de su lienzo (hasta un tope) o, sin lienzo, según sus botones. */
function widthOf(view: ScreenView): number {
  if (view.canvas) return Math.min(560, Math.max(300, view.canvas.w + PAD * 2))
  const labels = view.buttons.reduce((sum, button) => sum + buttonWidth(button.label) + GAP, 0)
  return Math.min(560, Math.max(320, Math.ceil(labels / 2) + PAD * 2))
}

const buttonWidth = (label: string) => Math.max(44, Math.round(label.length * 8.2 + 26))

/** Cuántas filas ocupan los botones en ese ancho. */
function buttonRows(view: ScreenView, width: number): number {
  let rows = 0
  let used = Infinity
  const room = width - PAD * 2
  for (const button of view.buttons) {
    const own = buttonWidth(button.label)
    if (used + GAP + own > room) {
      rows++
      used = own
    } else used += GAP + own
  }
  return rows
}

/** Lo que mide el nodo: su cabecera, su lienzo (a escala), sus botones, su texto, sus teclas y su aviso. */
export function screenSize(view: ScreenView): { w: number; h: number } {
  const w = widthOf(view)
  const rows = buttonRows(view, w)
  const parts = [
    view.canvas ? Math.round(view.canvas.h * Math.min(1, (w - PAD * 2) / view.canvas.w)) : 0,
    rows > 0 ? rows * BUTTON_H + (rows - 1) * GAP : 0,
    textRoom(view),
    view.keys.length > 0 ? KEYS_H : 0,
    view.error ? ERROR_H : 0,
  ].filter((height) => height > 0)
  const body = parts.reduce((sum, height) => sum + height, 0) + GAP * Math.max(0, parts.length - 1)
  return { w, h: HEAD + Math.max(56, body) + BODY_PAD + 3 }
}

/**
 * El sitio del texto: fijo (las últimas líneas) en cuanto la pantalla tiene algo que usar, para que el nodo
 * no crezca ni se mueva mientras se toca.
 */
const textRoom = (view: ScreenView) =>
  view.lines.length > 0 || view.buttons.length > 0 || view.keys.length > 0 ? MAX_LINES * LINE : 0

export interface ScreenNodeData extends Record<string, unknown> {
  panel: ScreenPanel
  size: { w: number; h: number }
}

export type ScreenFlowNode = Node<ScreenNodeData, 'screen'>

export function ScreenNode({ data }: NodeProps<ScreenFlowNode>) {
  const { panel, size } = data
  return (
    <div
      className="screen-node nodrag nopan"
      style={{ width: size.w, height: size.h }}
      data-phase={panel.view.phase}
    >
      <Handle
        type="target"
        id="in"
        position={Position.Left}
        isConnectable={false}
        className="note-handle"
      />
      <ScreenContent panel={panel} width={size.w} />
    </div>
  )
}

/**
 * La misma pantalla fuera del diagrama (en la idea del programa, que es lo que se ve primero en el móvil):
 * ocupa el ancho que haya y crece con lo que tenga.
 */
export function ScreenCard({ panel }: { panel: ScreenPanel }) {
  return (
    <div className="screen-node" data-fluid="" data-phase={panel.view.phase}>
      <ScreenContent panel={panel} width={screenSize(panel.view).w} fluid />
    </div>
  )
}

/** Lo de dentro de la pantalla: su cabecera y lo que se usa (el lienzo, los botones, el texto, las teclas). */
function ScreenContent({
  panel,
  width,
  fluid = false,
}: {
  panel: ScreenPanel
  width: number
  fluid?: boolean
}) {
  const { view } = panel
  const lines = view.lines.slice(-MAX_LINES)
  return (
    <>
      <header className="screen-node__head">
        <span className="screen-node__title">{view.title ?? 'Pantalla'}</span>
        <span className="screen-node__state">
          {view.phase === 'loading'
            ? 'arrancando…'
            : view.phase === 'failed'
              ? 'se paró'
              : view.phase === 'running'
                ? 'úsalo'
                : ''}
        </span>
        <button
          type="button"
          className="screen-node__restart"
          title="Volver a arrancarlo de cero"
          aria-label="Volver a arrancarlo"
          onClick={panel.onRestart}
        >
          ↻
        </button>
      </header>
      <div className="screen-node__body">
        {view.phase === 'idle' && (
          <button type="button" className="screen-node__start" onClick={panel.onRestart}>
            <span aria-hidden>▶</span> Empezar
          </button>
        )}
        {view.canvas && (
          <Drawing
            canvas={view.canvas}
            width={width - PAD * 2}
            fluid={fluid}
            onPoint={
              view.phase === 'running' && ((view.zones?.length ?? 0) > 0 || view.touch != null)
                ? (x, y) => {
                    // La zona de más arriba (la última que se dibujó) gana; si no hay, el lienzo entero.
                    const zone = [...(view.zones ?? [])]
                      .reverse()
                      .find(
                        (one) =>
                          x >= one.x && x <= one.x + one.w && y >= one.y && y <= one.y + one.h,
                      )
                    if (zone) panel.onPress(zone.id)
                    else if (view.touch != null) panel.onPress(view.touch, [x, y])
                  }
                : undefined
            }
          />
        )}
        {view.buttons.length > 0 && (
          <div className="screen-node__buttons">
            {view.buttons.map((button) => (
              <button
                key={button.id}
                type="button"
                className="screen-node__button"
                style={button.color ? { background: button.color } : undefined}
                disabled={view.phase !== 'running'}
                onPointerDown={(event) => {
                  // Al pulsar (no al soltar): un instrumento suena en cuanto se toca.
                  if (event.button !== 0) return
                  event.preventDefault()
                  panel.onPress(button.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    panel.onPress(button.id)
                  }
                }}
              >
                {button.label}
              </button>
            ))}
          </div>
        )}
        {textRoom(view) > 0 && (
          <div
            className="screen-node__lines"
            role="log"
            aria-live="polite"
            style={{ height: textRoom(view) }}
          >
            {lines.map((line, at) => (
              <p key={`${at}:${line}`}>{line}</p>
            ))}
          </div>
        )}
        {view.keys.length > 0 && (
          <p className="screen-node__keys">
            Teclas:{' '}
            {view.keys.map((key, at) => (
              <kbd key={at}>{key}</kbd>
            ))}
          </p>
        )}
        {view.error && (
          <p className="screen-node__error" role="alert">
            {view.error.message}
            {view.error.line === null ? '' : ` (línea ${view.error.line})`}
          </p>
        )}
        {view.phase === 'loading' && view.buttons.length === 0 && !view.canvas && (
          <p className="screen-node__hint">Poniéndolo en marcha…</p>
        )}
      </div>
    </>
  )
}

/** El lienzo donde dibuja el programa, a escala para que quepa. */
function Drawing({
  canvas,
  width,
  onPoint,
  fluid = false,
}: {
  canvas: NonNullable<ScreenView['canvas']>
  width: number
  /** Ocupa el ancho que haya (fuera del diagrama), sin pasar de su tamaño. */
  fluid?: boolean
  /** Se pulsó en el lienzo, en (x, y) de sus propias medidas. */
  onPoint?: ((x: number, y: number) => void) | undefined
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const scale = Math.min(1, width / canvas.w)
  useEffect(() => {
    const context = ref.current?.getContext('2d')
    if (!context) return
    context.fillStyle = canvas.bg
    context.fillRect(0, 0, canvas.w, canvas.h)
    for (const shape of canvas.shapes) {
      context.fillStyle = shape.color
      context.strokeStyle = shape.color
      if (shape.shape === 'rect') context.fillRect(shape.x, shape.y, shape.w, shape.h)
      else if (shape.shape === 'circle') {
        context.beginPath()
        context.arc(shape.x, shape.y, Math.max(0, shape.r), 0, Math.PI * 2)
        context.fill()
      } else if (shape.shape === 'line') {
        context.lineWidth = shape.width
        context.beginPath()
        context.moveTo(shape.x, shape.y)
        context.lineTo(shape.x2, shape.y2)
        context.stroke()
      } else {
        context.font = `${shape.size}px sans-serif`
        context.textBaseline = 'top'
        context.fillText(shape.text, shape.x, shape.y)
      }
    }
  }, [canvas])
  return (
    <canvas
      ref={ref}
      className="screen-node__canvas"
      width={canvas.w}
      height={canvas.h}
      data-touchable={onPoint ? '' : undefined}
      style={
        fluid
          ? { width: '100%', maxWidth: canvas.w, height: 'auto' }
          : { width: canvas.w * scale, height: canvas.h * scale }
      }
      onPointerDown={
        onPoint
          ? (event) => {
              if (event.button !== 0) return
              event.preventDefault()
              const box = event.currentTarget.getBoundingClientRect()
              // (El lienzo puede verse más pequeño, y el diagrama, con zoom: se pasa a sus medidas.)
              onPoint(
                Math.round(((event.clientX - box.left) / box.width) * canvas.w),
                Math.round(((event.clientY - box.top) / box.height) * canvas.h),
              )
            }
          : undefined
      }
    />
  )
}
