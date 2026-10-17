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
  phase: 'idle' | 'loading' | 'running' | 'failed'
  title: string | null
  lines: readonly string[]
  buttons: readonly { id: number; label: string; color?: string }[]
  /** Las teclas que usa, ya dichas para leerlas («a», «espacio», «←»). */
  keys: readonly string[]
  canvas: { w: number; h: number; bg: string; shapes: readonly ScreenShapeView[] } | null
  error: { message: string; line: number | null } | null
}

export interface ScreenPanel {
  view: ScreenView
  onPress: (id: number) => void
  /** Volver a arrancarlo de cero. */
  onRestart: () => void
}

const PAD = 12
const HEAD = 34
const LINE = 18
const BUTTON_H = 40
const GAP = 6
const MAX_LINES = 6

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
  const canvas = view.canvas
    ? Math.round(view.canvas.h * Math.min(1, (w - PAD * 2) / view.canvas.w)) + GAP
    : 0
  const rows = buttonRows(view, w)
  const lines = Math.min(MAX_LINES, view.lines.length)
  const body =
    canvas +
    (rows > 0 ? rows * BUTTON_H + (rows - 1) * GAP + GAP : 0) +
    (lines > 0 ? lines * LINE + GAP : 0) +
    (view.keys.length > 0 ? 22 : 0) +
    (view.error ? 46 : 0)
  return { w, h: HEAD + Math.max(56, body) + PAD }
}

export interface ScreenNodeData extends Record<string, unknown> {
  panel: ScreenPanel
  size: { w: number; h: number }
}

export type ScreenFlowNode = Node<ScreenNodeData, 'screen'>

export function ScreenNode({ data }: NodeProps<ScreenFlowNode>) {
  const { panel, size } = data
  const { view } = panel
  const lines = view.lines.slice(-MAX_LINES)
  return (
    <div
      className="screen-node nodrag nopan"
      style={{ width: size.w, height: size.h }}
      data-phase={view.phase}
    >
      <Handle
        type="target"
        id="in"
        position={Position.Left}
        isConnectable={false}
        className="note-handle"
      />
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
        {view.canvas && <Drawing canvas={view.canvas} width={size.w - PAD * 2} />}
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
        {lines.length > 0 && (
          <div className="screen-node__lines" role="log" aria-live="polite">
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
    </div>
  )
}

/** El lienzo donde dibuja el programa, a escala para que quepa. */
function Drawing({ canvas, width }: { canvas: NonNullable<ScreenView['canvas']>; width: number }) {
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
      style={{ width: canvas.w * scale, height: canvas.h * scale }}
    />
  )
}
