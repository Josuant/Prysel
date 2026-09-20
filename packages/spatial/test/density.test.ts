import { describe, expect, it } from 'vitest'
import { analyze, generateProgram, layout, type Legibility } from '../src/index.ts'

/**
 * ¿El diagrama se sigue entendiendo cuando el programa deja de tener seis nodos?
 *
 * Estos tests fijan lo que ya se cumple, para que no se degrade. El límite que NO se
 * cumple —un programa largo se vuelve una tira horizontal impracticable— está medido
 * en `scripts/density.ts` y documentado en `docs/spatial-grammar.md`.
 */

const SIZES = [6, 12, 25, 50, 100]
const measure = (steps: number): Legibility => {
  const graph = generateProgram({ steps })
  return analyze(graph, layout(graph))
}

describe.each(SIZES)('un programa de %i pasos', (steps) => {
  const m = measure(steps)

  it('no pisa ningún nodo contra otro', () => {
    expect(m.overlaps).toBe(0)
  })

  it('no manda ninguna conexión de flujo hacia atrás: solo los retornos van contra el tiempo', () => {
    expect(m.backward).toBe(0)
  })

  it('coloca todos los nodos dentro del lienzo que declara', () => {
    expect(m.bounds.w).toBeGreaterThan(0)
    expect(m.bounds.h).toBeGreaterThan(0)
  })
})

describe('cómo escala la legibilidad', () => {
  it('los cruces por conexión no crecen con el tamaño del programa', () => {
    const small = measure(12).crossingsPerEdge
    const large = measure(100).crossingsPerEdge
    expect(large).toBeLessThanOrEqual(small)
    expect(large).toBeLessThan(0.5)
  })

  it('ninguna columna se dispara: el ancho lo marca el flujo, no un amontonamiento', () => {
    for (const steps of SIZES) {
      expect(measure(steps).densest, `${steps} pasos`).toBeLessThanOrEqual(8)
    }
  })

  it('colocar un programa grande es instantáneo', () => {
    const graph = generateProgram({ steps: 200 })
    const started = performance.now()
    layout(graph)
    expect(performance.now() - started).toBeLessThan(500)
  })

  /**
   * La prueba que motivó el plegado: un programa largo tiene que poder leerse.
   * La medida honesta de un lienzo plegado no es «verlo entero de un vistazo» sino
   * «leerlo al 100 % recorriéndolo», como un documento.
   */
  it('cualquier programa se lee a tamaño completo recorriéndolo hacia abajo', () => {
    for (const steps of [...SIZES, 200]) {
      expect(measure(steps).nodeWidthScrolling, `${steps} pasos`).toBeGreaterThanOrEqual(258)
    }
  })

  it('una fila cabe en una pantalla: por eso no hace falta alejarse', () => {
    for (const steps of SIZES) {
      expect(measure(steps).bounds.w, `${steps} pasos`).toBeLessThanOrEqual(1920)
    }
  })

  it('el programa se pliega en filas en vez de crecer sin fin a lo ancho', () => {
    expect(measure(6).rows).toBeGreaterThan(1)
    expect(measure(100).rows).toBeGreaterThan(measure(25).rows)
    // Todo salto de fila es eso, un salto de línea: nunca un retroceso dentro de la fila.
    expect(measure(50).wraps).toBeGreaterThan(0)
  })
})

describe('el generador produce programas con forma de programa', () => {
  const graph = generateProgram({ steps: 25 })

  it('incluye decisiones, bucles, imports y constantes compartidas', () => {
    const ids = graph.nodes.map((n) => n.id)
    expect(ids.some((id) => id.startsWith('if:'))).toBe(true)
    expect(ids.some((id) => id.startsWith('for:'))).toBe(true)
    expect(ids.some((id) => id.startsWith('import:'))).toBe(true)
    expect(ids.some((id) => id.startsWith('CONST_'))).toBe(true)
    expect(graph.edges.some((e) => e.relation === 'feedback')).toBe(true)
    expect(graph.edges.some((e) => e.relation === 'reference')).toBe(true)
  })

  it('es determinista: la misma semilla da el mismo programa', () => {
    expect(generateProgram({ steps: 25 })).toEqual(graph)
  })
})
