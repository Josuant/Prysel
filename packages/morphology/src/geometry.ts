import type { Insets, ShapeGeometry, ShapeId } from './types.ts'

/**
 * Siluetas. Todas son variaciones de una tarjeta: el área de contenido siempre es
 * rectangular (por eso caben insignia, título, código, control editable y chip de estado),
 * y lo que cambia es cómo se recortan o se decoran sus bordes.
 */

const num = (v: number) => String(Math.round(v * 100) / 100)

const R_CARD = 14
const R_SPACE = 20
/** Profundidad de la punta de una flecha: fija, para que no crezca con el nodo. */
const TIP = 14
/** Alto de la pestaña de una función y de la barra de título de una ventana. */
const TAB_H = 16
const TITLE_H = 34
/** Desplazamiento de cada capa trasera de una pila. */
const STACK = 5

function roundRect(w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  const [a, x1, x2, y1, y2] = [num(r), num(w - r), num(w), num(h - r), num(h)]
  return (
    `M${a} 0H${x1}A${a} ${a} 0 0 1 ${x2} ${a}V${y1}A${a} ${a} 0 0 1 ${x1} ${y2}` +
    `H${a}A${a} ${a} 0 0 1 0 ${y1}V${a}A${a} ${a} 0 0 1 ${a} 0Z`
  )
}

function line(x1: number, y1: number, x2: number, y2: number): string {
  return `M${num(x1)} ${num(y1)}L${num(x2)} ${num(y2)}`
}

const inset = (top: number, right: number, bottom: number, left: number): Insets => ({
  top: Math.round(top),
  right: Math.round(right),
  bottom: Math.round(bottom),
  left: Math.round(left),
})

const NO_OVERFLOW: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
const PAD = inset(12, 14, 12, 14)
const sides = (w: number, h: number): ShapeGeometry['handles'] => ({
  in: { x: 0, y: h / 2 },
  out: { x: w, y: h / 2 },
})

type Builder = (w: number, h: number) => ShapeGeometry

const shape = (
  d: string,
  w: number,
  h: number,
  extra: Partial<Omit<ShapeGeometry, 'd'>> = {},
): ShapeGeometry => ({
  d,
  layers: [],
  handles: sides(w, h),
  overflow: NO_OVERFLOW,
  inset: PAD,
  ...extra,
})

const builders: Record<ShapeId, Builder> = {
  card: (w, h) => shape(roundRect(w, h, R_CARD), w, h),

  /** Tarjeta con punta de flecha: el dato entra por la izquierda y sale transformado. */
  'card-chevron': (w, h) => {
    const d =
      `M${R_CARD} 0H${num(w - TIP - 6)}Q${num(w - TIP)} 0 ${num(w - TIP + 3)} ${num(h * 0.18)}` +
      `L${num(w - 2)} ${num(h / 2 - 3)}a4 4 0 0 1 0 6L${num(w - TIP + 3)} ${num(h * 0.82)}` +
      `Q${num(w - TIP)} ${num(h)} ${num(w - TIP - 6)} ${num(h)}` +
      `H${R_CARD}A${R_CARD} ${R_CARD} 0 0 1 0 ${num(h - R_CARD)}V${R_CARD}A${R_CARD} ${R_CARD} 0 0 1 ${R_CARD} 0Z`
    return shape(d, w, h, { inset: inset(12, TIP + 12, 12, 14) })
  },

  /** Capas apiladas detrás: muchos elementos dentro de un solo objeto. */
  'card-stack': (w, h) => {
    const d = roundRect(w, h, R_CARD)
    return shape(d, w, h, {
      layers: [
        { d, kind: 'back', dx: STACK * 2, dy: -STACK * 2 },
        { d, kind: 'back', dx: STACK, dy: -STACK },
      ],
      overflow: inset(STACK * 2, STACK * 2, 0, 0),
    })
  },

  /** Ventana con barra de título: un resultado persistente, hecho para mirarse. */
  'card-window': (w, h) =>
    shape(roundRect(w, h, R_CARD), w, h, {
      layers: [{ d: line(0, TITLE_H, w, TITLE_H), kind: 'detail' }],
      headerBand: TITLE_H,
      inset: inset(0, 14, 12, 14),
    }),

  /** Barra de título dividida en columnas: la silueta de una tabla, sin invadir el contenido. */
  'card-grid': (w, h) =>
    shape(roundRect(w, h, R_CARD), w, h, {
      layers: [
        { d: line(0, TITLE_H, w, TITLE_H), kind: 'detail' },
        { d: line(w * 0.52, 8, w * 0.52, TITLE_H), kind: 'detail' },
        { d: line(w * 0.76, 8, w * 0.76, TITLE_H), kind: 'detail' },
      ],
      headerBand: TITLE_H,
      inset: inset(0, 14, 12, 14),
    }),

  /** Borde derecho plano: el valor sale de la función y no continúa en el lienzo. */
  'card-endcap': (w, h) =>
    shape(
      `M${R_CARD} 0H${num(w)}V${num(h)}H${R_CARD}A${R_CARD} ${R_CARD} 0 0 1 0 ${num(h - R_CARD)}` +
        `V${R_CARD}A${R_CARD} ${R_CARD} 0 0 1 ${R_CARD} 0Z`,
      w,
      h,
      { inset: inset(12, 16, 12, 14) },
    ),

  /**
   * Lado derecho completamente redondeado, como la pista de un interruptor:
   * el nodo solo puede estar en uno de dos estados.
   */
  'card-toggle': (w, h) => {
    const r = h / 2
    const d =
      `M${R_CARD} 0H${num(w - r)}A${num(r)} ${num(r)} 0 0 1 ${num(w - r)} ${num(h)}` +
      `H${R_CARD}A${R_CARD} ${R_CARD} 0 0 1 0 ${num(h - R_CARD)}V${R_CARD}A${R_CARD} ${R_CARD} 0 0 1 ${R_CARD} 0Z`
    return shape(d, w, h, { inset: inset(12, Math.min(r * 0.8, 34), 12, 14) })
  },

  /** Pestaña de carpeta: complejidad encapsulada que se puede abrir. */
  'card-tab': (w, h) => {
    const r = 10
    const tabW = Math.min(w * 0.44, 124)
    const d =
      `M0 ${r}A${r} ${r} 0 0 1 ${r} 0H${num(tabW - r)}A${r} ${r} 0 0 1 ${num(tabW)} ${r}` +
      `L${num(tabW + 12)} ${TAB_H}H${num(w - R_CARD)}A${R_CARD} ${R_CARD} 0 0 1 ${num(w)} ${num(TAB_H + R_CARD)}` +
      `V${num(h - R_CARD)}A${R_CARD} ${R_CARD} 0 0 1 ${num(w - R_CARD)} ${num(h)}` +
      `H${R_CARD}A${R_CARD} ${R_CARD} 0 0 1 0 ${num(h - R_CARD)}Z`
    return shape(d, w, h, { inset: inset(TAB_H + 10, 14, 12, 14) })
  },

  /** Muescas de billete: viene de fuera del archivo, no es tuyo. */
  'card-notch': (w, h) => {
    const r = 8
    const cy = h / 2
    const d =
      `M${R_CARD} 0H${num(w - R_CARD)}A${R_CARD} ${R_CARD} 0 0 1 ${num(w)} ${R_CARD}` +
      `V${num(cy - r)}A${r} ${r} 0 0 0 ${num(w)} ${num(cy + r)}V${num(h - R_CARD)}` +
      `A${R_CARD} ${R_CARD} 0 0 1 ${num(w - R_CARD)} ${num(h)}H${R_CARD}` +
      `A${R_CARD} ${R_CARD} 0 0 1 0 ${num(h - R_CARD)}V${num(cy + r)}` +
      `A${r} ${r} 0 0 0 0 ${num(cy - r)}V${R_CARD}A${R_CARD} ${R_CARD} 0 0 1 ${R_CARD} 0Z`
    return shape(d, w, h, { inset: inset(12, 18, 12, 18) })
  },

  /** Esquina cortada: el flujo se detiene aquí. */
  'card-cut': (w, h) => {
    const c = 22
    const d =
      `M${R_CARD} 0H${num(w - c)}L${num(w)} ${num(c)}V${num(h - R_CARD)}` +
      `A${R_CARD} ${R_CARD} 0 0 1 ${num(w - R_CARD)} ${num(h)}H${R_CARD}` +
      `A${R_CARD} ${R_CARD} 0 0 1 0 ${num(h - R_CARD)}V${R_CARD}A${R_CARD} ${R_CARD} 0 0 1 ${R_CARD} 0Z`
    return shape(d, w, h)
  },

  /** Dos salidas reales en el borde derecho: verdadero arriba, falso abajo. */
  'card-fork': (w, h) =>
    shape(roundRect(w, h, R_CARD), w, h, {
      layers: [{ d: line(w - 20, h * 0.56, w, h * 0.56), kind: 'detail' }],
      handles: {
        in: { x: 0, y: h / 2 },
        out: { x: w, y: h * 0.32 },
        alt: { x: w, y: h * 0.78 },
      },
    }),

  /** Arco de retorno bajo el contenido: el control vuelve al inicio. */
  'card-loop': (w, h) => {
    const y = h - 11
    const d = `M${num(w - 22)} ${num(y)}H26M31 ${num(y - 4.5)}L26 ${num(y)}L31 ${num(y + 4.5)}`
    return shape(roundRect(w, h, R_CARD), w, h, {
      layers: [{ d, kind: 'detail' }],
      inset: inset(12, 14, 22, 14),
    })
  },

  /** Borde izquierdo plano: el flujo sale de la función y no continúa. */
  'card-flag': (w, h) =>
    shape(
      `M0 0H${num(w - R_CARD)}A${R_CARD} ${R_CARD} 0 0 1 ${num(w)} ${R_CARD}` +
        `V${num(h - R_CARD)}A${R_CARD} ${R_CARD} 0 0 1 ${num(w - R_CARD)} ${num(h)}H0Z`,
      w,
      h,
      { inset: inset(12, 14, 12, 16) },
    ),

  /** Doble contorno: el código sale del programa y toca el mundo. */
  'card-double': (w, h) =>
    shape(roundRect(w, h, R_CARD), w, h, {
      layers: [{ d: roundRect(w - 8, h - 8, R_CARD - 4), kind: 'detail', dx: 4, dy: 4 }],
      inset: inset(15, 17, 15, 17),
    }),

  pill: (w, h) => shape(roundRect(w, h, h / 2), w, h, { inset: inset(0, 12, 0, 12) }),

  'pill-chevron': (w, h) => {
    const r = h / 2
    const d =
      `M${num(r)} 0H${num(w - TIP)}L${num(w - 2)} ${num(h / 2 - 3)}a4 4 0 0 1 0 6` +
      `L${num(w - TIP)} ${num(h)}H${num(r)}A${num(r)} ${num(r)} 0 0 1 ${num(r)} 0Z`
    return shape(d, w, h, { inset: inset(0, TIP + 4, 0, 12) })
  },

  'pill-cut': (w, h) => {
    const r = h / 2
    const c = 11
    const d =
      `M${num(r)} 0H${num(w - c)}L${num(w)} ${num(c)}V${num(h - r)}` +
      `A${num(r)} ${num(r)} 0 0 1 ${num(w - r)} ${num(h)}H${num(r)}A${num(r)} ${num(r)} 0 0 1 ${num(r)} 0Z`
    return shape(d, w, h, { inset: inset(0, 12, 0, 12) })
  },

  /** Territorio: un contenedor que abarca otros nodos. */
  frame: (w, h) => shape(roundRect(w, h, R_SPACE), w, h, { inset: inset(10, 16, 14, 16) }),

  /** Dos carriles físicamente separados: la bifurcación es real. */
  'frame-fork': (w, h) =>
    shape(roundRect(w, h, R_SPACE), w, h, {
      layers: [{ d: line(16, h * 0.56, w - 16, h * 0.56), kind: 'detail' }],
      handles: { in: { x: 0, y: h / 2 }, out: { x: w, y: h * 0.34 }, alt: { x: w, y: h * 0.78 } },
      inset: inset(10, 16, 14, 16),
    }),

  /** Un carril principal y, debajo, uno de recuperación. */
  'frame-guard': (w, h) =>
    shape(roundRect(w, h, R_SPACE), w, h, {
      layers: [{ d: line(16, h * 0.68, w - 16, h * 0.68), kind: 'detail' }],
      inset: inset(10, 16, 14, 16),
    }),
}

export function buildShape(id: ShapeId, w: number, h: number): ShapeGeometry {
  return builders[id](w, h)
}

export const SHAPE_IDS = Object.keys(builders) as ShapeId[]
