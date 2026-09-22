import type { InsightIdentifier, NoteStyleId } from '../lesson.ts'

/**
 * Un modelo pequeño a veces traduce los códigos fijos del formato (el estilo de una nota, «value»/«output»,
 * los nodos de «show») aunque el resto de la lección vaya en el idioma pedido. Se corrige antes de validar:
 * es una tolerancia sobre lo que escribe la IA, no sobre el formato en sí — un guion escrito a mano sigue
 * exigiendo el código exacto (`parseLesson` no pasa por aquí).
 */

const EXPECT_SYNONYMS: Record<string, 'value' | 'output'> = {
  value: 'value',
  valor: 'value',
  valores: 'value',
  output: 'output',
  salida: 'output',
  impresion: 'output',
  imprime: 'output',
  print: 'output',
  printed: 'output',
}

const STYLE_SYNONYMS: Record<string, NoteStyleId> = {
  sticky: 'sticky',
  adhesiva: 'sticky',
  nota: 'sticky',
  callout: 'callout',
  llamada: 'callout',
  fijate: 'callout',
  warning: 'warning',
  aviso: 'warning',
  ojo: 'warning',
  alerta: 'warning',
  definition: 'definition',
  definicion: 'definition',
  analogy: 'analogy',
  analogia: 'analogy',
  margin: 'margin',
  margen: 'margin',
}

const INSIGHT_SYNONYMS: Record<string, InsightIdentifier> = {
  variables: 'variables',
  variable: 'variables',
  stack: 'stack',
  pila: 'stack',
  tree: 'tree',
  arbol: 'tree',
  memory: 'memory',
  memoria: 'memory',
  collection: 'collection',
  coleccion: 'collection',
  lista: 'collection',
}

/** Sin tildes ni mayúsculas, para que «árbol» y «arbol» sean la misma clave. */
const key = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
    : ''

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export function normalizeAiJson(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (Array.isArray(value['show'])) {
    value['show'] = value['show'].map((entry) => INSIGHT_SYNONYMS[key(entry)] ?? entry)
  }
  if (Array.isArray(value['beats'])) {
    value['beats'] = value['beats'].map((entry) => {
      if (!isRecord(entry)) return entry
      const note = entry['note']
      if (isRecord(note) && typeof note['style'] === 'string') {
        note['style'] = STYLE_SYNONYMS[key(note['style'])] ?? note['style']
      }
      const ask = entry['ask']
      if (isRecord(ask) && typeof ask['expect'] === 'string') {
        ask['expect'] = EXPECT_SYNONYMS[key(ask['expect'])] ?? ask['expect']
      }
      return entry
    })
  }
  return value
}
