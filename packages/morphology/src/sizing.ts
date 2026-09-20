import type { Density, Metrics, NodeKindSpec, ScaleBy, ShapeId } from './types.ts'

/**
 * Tamaño base por densidad (w × h), en píxeles del lienzo.
 * `compact` es una píldora: icono, nombre y punto de estado — la referencia rápida de la lógica.
 * `normal` cabe insignia + título + código + pie, con el control editable resumido.
 * `expanded` da sitio al control editable completo.
 */
export const DENSITY_BASE: Record<Density, readonly [number, number]> = {
  compact: [200, 36],
  normal: [258, 156],
  expanded: [300, 248],
}

/**
 * Cuánto puede desviarse un tipo del tamaño base de su densidad. El suelo garantiza que
 * la insignia, el título y el control siempre quepan: la variedad nunca rompe la legibilidad.
 */
const FOOTPRINT_RANGE = [0.92, 1.6] as const
/** En expandido la variación de tipo se amortigua: todos necesitan sitio para su editor. */
const EXPANDED_DAMPING = { w: 0.6, h: 0.35 }

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const snap = (v: number) => Math.round(v / 2) * 2

/**
 * El tamaño mide complejidad, no importancia (presupuesto de complejidad del DS):
 * crece de forma logarítmica y se satura, para que un algoritmo enorme no devore el lienzo.
 */
export function complexityScale(scaleBy: ScaleBy, metrics: Metrics = {}): number {
  switch (scaleBy) {
    case 'ops':
      return clamp(1 + 0.055 * Math.log2(1 + (metrics.ops ?? 0)), 1, 1.28)
    case 'cardinality':
      return clamp(1 + 0.07 * Math.log10(1 + (metrics.cardinality ?? 0)), 1, 1.22)
    case 'none':
      return 1
  }
}

/**
 * En compacto todo nodo es una píldora de la misma altura: una fila de etiquetas que se lee
 * de un vistazo. El recorte dice si transforma o si corta el flujo; el resto lo dicen icono y color.
 */
export function compactShape(kind: Pick<NodeKindSpec, 'id' | 'role'>): ShapeId {
  if (kind.role === 'transform') return 'pill-chevron'
  if (kind.id === 'control.raise') return 'pill-cut'
  return 'pill'
}

/** Al expandirse, una píldora se convierte en tarjeta: necesita sitio para su editor. */
const PILL_TO_CARD: Partial<Record<ShapeId, ShapeId>> = {
  pill: 'card',
  'pill-chevron': 'card-chevron',
  'pill-cut': 'card-cut',
}

export function shapeFor(kind: NodeKindSpec, density: Density): ShapeId {
  if (density === 'compact') return compactShape(kind)
  if (density === 'expanded') return PILL_TO_CARD[kind.shape] ?? kind.shape
  return kind.shape
}

export function nodeSize(
  kind: Pick<NodeKindSpec, 'footprint' | 'scaleBy'>,
  density: Density,
  metrics?: Metrics,
): { w: number; h: number } {
  const [baseW, baseH] = DENSITY_BASE[density]
  const scale = complexityScale(kind.scaleBy, metrics)
  const fw = clamp(kind.footprint.w, ...FOOTPRINT_RANGE)
  const fh = clamp(kind.footprint.h, ...FOOTPRINT_RANGE)

  if (density === 'compact') {
    // Misma altura para todos: una fila de píldoras alineadas.
    return { w: snap(baseW * clamp(fw, 0.9, 1.12) * Math.min(scale, 1.1)), h: baseH }
  }
  if (density === 'expanded') {
    const damp = (f: number, k: number) => 1 + (f - 1) * k
    return {
      w: snap(baseW * damp(fw, EXPANDED_DAMPING.w) * damp(scale, EXPANDED_DAMPING.w)),
      h: snap(baseH * damp(fh, EXPANDED_DAMPING.h) * damp(scale, EXPANDED_DAMPING.h)),
    }
  }
  // La complejidad ensancha el nodo mucho más de lo que lo alarga: el alto lo manda el contenido.
  return { w: snap(baseW * fw * scale), h: snap(baseH * fh * (1 + (scale - 1) * 0.45)) }
}
