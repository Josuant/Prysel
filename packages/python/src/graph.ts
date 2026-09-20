import { getKind, nodeSize, type Density, type Metrics } from '@prysel/morphology'
import type { SemanticGraph } from '@prysel/spatial'
import type { Program } from './program.ts'

/** Del programa analizado al grafo que entiende la gramática espacial. */
export function toSemanticGraph(program: Program, density: Density = 'normal'): SemanticGraph {
  return {
    nodes: program.nodes.map((node) => {
      const spec = getKind(node.kind)
      const metrics: Metrics = node.ops === undefined ? {} : { ops: node.ops }
      return {
        id: node.id,
        role: spec.role,
        size: nodeSize(spec, density, metrics),
        ...(node.contains ? { contains: node.contains } : {}),
        ...(node.ops === undefined ? {} : { ops: node.ops }),
      }
    }),
    edges: program.edges,
  }
}
