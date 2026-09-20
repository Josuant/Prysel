// Uso: node scripts/density.ts
// Mide si el diagrama se sigue entendiendo cuando el programa crece.
import { analyze, generateProgram, layout } from '../src/index.ts'

const SIZES = [6, 12, 25, 50, 100, 200]
const rows = SIZES.map((steps) => {
  const graph = generateProgram({ steps })
  const started = performance.now()
  const result = layout(graph)
  const ms = performance.now() - started
  const m = analyze(graph, result)
  return {
    pasos: steps,
    nodos: m.nodes,
    conexiones: m.edges,
    solapes: m.overlaps,
    cruces: m.crossings,
    'cruces/conexión': Number(m.crossingsPerEdge.toFixed(2)),
    'hacia atrás': m.backward,
    filas: m.rows,
    'saltos largos': m.longJumps,
    'long. media': Math.round(m.avgEdgeLength),
    'capa + poblada': m.densest,
    'nodo al encajar': `${m.nodeWidthAtFit}px`,
    'nodo con scroll': `${m.nodeWidthScrolling}px`,
    lienzo: `${m.bounds.w}×${m.bounds.h}`,
    proporción: Number(m.aspect.toFixed(1)),
    ms: Number(ms.toFixed(1)),
  }
})
console.table(rows)
