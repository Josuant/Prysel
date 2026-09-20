import type { Relation } from '@prysel/spatial'

/**
 * Gramática de conexiones. La relación computacional decide el trazo, la punta y la curvatura;
 * el color solo se usa para el estado (activa / fallida), nunca para distinguir el tipo de relación.
 *
 *   dependency  A ──▸ B   B usa el valor de A
 *   transform   A ━━▸ B   el dato entra y sale distinto (el flujo principal)
 *   branch      A ──▸ B   una salida etiquetada de una decisión
 *   merge       A ──▸ D   varias fuentes que desembocan en el mismo sitio
 *   feedback    A ⤺  B   el control vuelve atrás: la única que va contra el tiempo
 *   reference   A ┈┈▸ B   dependencia débil: un import, un símbolo al que se alude
 */

export interface EdgeProps {
  path: string
  relation: Relation
  /** Etiqueta de la relación ("verdadero", "falso", "cada fila"). */
  label?: string
  /** Punto donde colocar la etiqueta, en coordenadas del lienzo. */
  labelAt?: { x: number; y: number }
  /** Hay datos circulando ahora mismo. */
  live?: boolean
  /** La ejecución se rompió en esta conexión. */
  failed?: boolean
}

/** Las puntas de flecha. Se declaran una vez por lienzo. */
export function EdgeDefs() {
  return (
    <defs>
      {(['thin', 'thick'] as const).map((weight) => (
        <marker
          key={weight}
          id={`prysel-arrow-${weight}`}
          viewBox="0 0 10 10"
          refX={weight === 'thick' ? 7 : 8}
          refY={5}
          markerWidth={weight === 'thick' ? 5 : 6}
          markerHeight={weight === 'thick' ? 5 : 6}
          orient="auto-start-reverse"
        >
          <path className="edge__head" d="M1 1L9 5L1 9z" />
        </marker>
      ))}
    </defs>
  )
}

export function Edge({ path, relation, label, labelAt, live, failed }: EdgeProps) {
  const weight = relation === 'transform' ? 'thick' : 'thin'
  return (
    <g
      className="edge"
      data-relation={relation}
      data-live={live ? '' : undefined}
      data-failed={failed ? '' : undefined}
    >
      <path className="edge__line" d={path} markerEnd={`url(#prysel-arrow-${weight})`} />
      {live && (
        <circle className="edge__pulse" r={3.5}>
          <animateMotion dur="1.5s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      {label && labelAt && (
        <g transform={`translate(${labelAt.x} ${labelAt.y})`}>
          <rect
            className="edge__label-bg"
            x={-label.length * 3.3 - 7}
            y={-9}
            width={label.length * 6.6 + 14}
            height={18}
            rx={9}
          />
          <text className="edge__label type-badge" textAnchor="middle" dy={4}>
            {label}
          </text>
        </g>
      )}
    </g>
  )
}
