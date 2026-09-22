import { CHANNEL_OF, type Channel, type Relation } from '@prysel/spatial'

/**
 * Gramática de conexiones. Hay dos canales, y son dos lenguajes visuales distintos:
 *
 *   control  ━━━▸   continua y gruesa: el orden de ejecución (rama, retorno de bucle, entrada al cuerpo)
 *   datos    ┈┈┈▸   fina y punteada: el paso de un valor de un nodo a otro
 *
 * Dentro de cada canal, la relación computacional afina el trazo y la curvatura;
 * el color solo se usa para el estado (activa / fallida), nunca para distinguir el tipo.
 *
 *   dependency  A ┈▸ B   B usa el valor de A
 *   transform   A ┈▸ B   el dato entra y sale distinto (el flujo principal de datos)
 *   reference   A ┈▸ B   dependencia débil: un import, un símbolo al que se alude
 *   branch      A ━▸ B   una salida etiquetada de una decisión
 *   feedback    A ⤺  B   el control vuelve atrás: la única que va contra el tiempo
 */

export interface EdgeProps {
  path: string
  relation: Relation
  /** Sin él, se deduce de la relación. */
  channel?: Channel
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
          refX={weight === 'thick' ? 6 : 8}
          refY={5}
          markerWidth={weight === 'thick' ? 3.4 : 4.2}
          markerHeight={weight === 'thick' ? 3.4 : 4.2}
          orient="auto-start-reverse"
        >
          <path className="edge__head" d="M1 1L9 5L1 9z" />
        </marker>
      ))}
      {/* La punta de la espina de la secuencia: más grande, para que se vea hacia dónde se lee. */}
      <marker
        id="prysel-arrow-spine"
        viewBox="0 0 10 10"
        refX={8}
        refY={5}
        markerWidth={6}
        markerHeight={6}
        orient="auto-start-reverse"
      >
        <path className="edge__head" d="M1 1L9 5L1 9z" />
      </marker>
    </defs>
  )
}

export function Edge({ path, relation, channel, label, labelAt, live, failed }: EdgeProps) {
  const lane = channel ?? CHANNEL_OF[relation]
  const weight = lane === 'control' ? 'thick' : 'thin'
  return (
    <g
      className="edge"
      data-relation={relation}
      data-channel={lane}
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
