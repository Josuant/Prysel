import { useEffect, useRef, useState } from 'react'
import { formatLap, pickCurves, spark, type LapsView } from '../laps.ts'

/**
 * La franja de vueltas de un bucle: un botón para reproducirlo, un deslizador para elegir la vuelta que
 * se mira y, por cada número que vale la pena vigilar (la pérdida, la precisión…), su curva con un punto
 * en esa vuelta y lo que vale. Vive dentro del territorio del bucle, en su cabecera.
 */

const SPARK = { w: 72, h: 22 }
/** Cada cuánto avanza una vuelta al reproducir. */
const STEP_MS = 110

export function LapsStrip({
  laps,
  exclude,
  label,
}: {
  laps: LapsView
  /** Las variables del propio bucle: no se dibujan. */
  exclude: readonly string[]
  label: string
}) {
  const { idx, names, position, n } = laps
  const last = Math.max(0, idx.length - 1)
  const [playing, setPlaying] = useState(false)
  const at = useRef(position)
  useEffect(() => {
    at.current = position
  })
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const next = at.current + 1
      if (next > last) {
        setPlaying(false)
        return
      }
      laps.onPosition?.(next)
    }, STEP_MS)
    return () => {
      clearInterval(timer)
    }
  }, [playing, last, laps])

  const curves = pickCurves(names, idx, exclude)
  const lap = (idx[position] ?? position) + 1
  const interactive = laps.onPosition !== undefined && idx.length > 1
  return (
    <div className="laps nodrag nowheel" role="group" aria-label={`Vueltas de ${label}`}>
      {interactive && (
        <button
          type="button"
          className="laps__play"
          aria-label={playing ? 'Detener la reproducción' : 'Reproducir las vueltas'}
          title={playing ? 'Detener' : 'Reproducir las vueltas'}
          onClick={() => {
            if (!playing && position >= last) laps.onPosition?.(0)
            setPlaying((on) => !on)
          }}
        >
          {playing ? '❚❚' : '▶'}
        </button>
      )}
      <span className="laps__lap">
        vuelta {lap}/{n}
        {laps.done ? '' : ' …'}
      </span>
      {interactive && (
        <input
          type="range"
          className="laps__range"
          min={0}
          max={last}
          value={position}
          aria-label="Vuelta que se mira"
          onChange={(event) => {
            setPlaying(false)
            laps.onPosition?.(Number(event.target.value))
          }}
        />
      )}
      {curves.map((name) => {
        const values = names[name] ?? []
        const curve = spark(values, idx, n, SPARK.w, SPARK.h)
        const dot = curve.dot(position)
        return (
          <span
            key={name}
            className="laps__curve"
            title={`${name}: ${formatLap(values[position])}`}
          >
            <span className="laps__name">{name}</span>
            <svg width={SPARK.w} height={SPARK.h} viewBox={`0 0 ${SPARK.w} ${SPARK.h}`} aria-hidden>
              <path d={curve.path} fill="none" />
              {dot && <circle cx={dot.x} cy={dot.y} r="2.6" />}
            </svg>
            <span className="laps__value">{formatLap(values[position])}</span>
          </span>
        )
      })}
    </div>
  )
}
