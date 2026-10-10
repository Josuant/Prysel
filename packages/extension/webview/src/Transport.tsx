import { useCallback, useEffect, useState } from 'react'
import type { Beat } from '@prysel/ui'
import type { Story } from '../../src/gist/story.ts'
import { lapsSaid } from './outcome.ts'

/**
 * **Ver pasar una vuelta.** La arquitectura contada por su ejecución ya dice qué pasa y en qué orden; aquí se
 * ve pasar: el foco va de módulo en módulo, una ficha recorre la flecha por la que llega cada dato, y al
 * cerrar la vuelta la tira dice cuántas dio de verdad y cómo salió.
 *
 * Nada de esto vuelve a ejecutar el programa: se reproduce lo que ya pasó.
 */

/** Lo que dura un paso, y lo que dura cuando se enseña solo (al acabar de construir): despacio. */
const BEAT_MS = 1200
const SLOW_MS = 2000
/** Lo que se queda en el último paso antes de soltar el foco. */
const REST_MS = 1400

export interface Playback {
  /** El paso en el que se está, o `null` si no se reproduce. */
  at: number | null
  playing: boolean
  /** Cambia en cada paso: es lo que hace que la ficha vuelva a salir. */
  serial: number
  ms: number
  play: (slow?: boolean) => void
  pause: () => void
  go: (at: number) => void
  stop: () => void
}

/** El mando de la reproducción de `count` pasos. Con otro número de pasos (otro programa), se suelta. */
export function usePlayback(count: number): Playback {
  const [state, setState] = useState({
    at: null as number | null,
    of: 0,
    playing: false,
    serial: 0,
  })
  const [slow, setSlow] = useState(false)
  const ms = slow ? SLOW_MS : BEAT_MS
  // Lo que se reproducía era de otra historia: ya no vale.
  const at = state.at !== null && state.of === count && state.at < count ? state.at : null
  const playing = state.playing && at !== null
  useEffect(() => {
    if (!playing || at === null) return
    const last = at + 1 >= count
    const timer = window.setTimeout(
      () => {
        setState((now) =>
          last
            ? { ...now, at: null, playing: false }
            : { ...now, at: at + 1, serial: now.serial + 1 },
        )
      },
      ms + (last ? REST_MS : 0),
    )
    return () => {
      window.clearTimeout(timer)
    }
  }, [playing, at, count, ms])
  const play = useCallback(
    (slowly = false) => {
      if (count === 0) return
      setSlow(slowly)
      setState((now) => ({
        at: now.at !== null && now.of === count && now.at < count - 1 ? now.at : 0,
        of: count,
        playing: true,
        serial: now.serial + 1,
      }))
    },
    [count],
  )
  const pause = useCallback(() => {
    setState((now) => ({ ...now, playing: false }))
  }, [])
  const go = useCallback(
    (to: number) => {
      setState((now) => ({ at: to, of: count, playing: false, serial: now.serial + 1 }))
    },
    [count],
  )
  const stop = useCallback(() => {
    setState((now) => ({ ...now, at: null, playing: false }))
  }, [])
  return { at, playing, serial: state.serial, ms, play, pause, go, stop }
}

/** Lo que se dice de un paso, con palabras. */
export function sayBeat(
  beat: Beat,
  title: string,
  carries: readonly string[],
  loop: Pick<Story['loop'], 'laps' | 'ended'>,
): string {
  const { laps } = loop
  // Lo mismo por dos flechas (la población recién hecha, y la que deja la vuelta anterior) se dice una vez.
  const names = [...new Set(carries)]
  const brings = names.length > 0 ? ` · recibe ${names.join(', ')}` : ''
  switch (beat.phase) {
    case 'before':
      return `Antes de empezar: ${title}`
    case 'again':
      return laps > 1 ? `Y otra vez: así ${lapsSaid(loop)} vueltas` : 'Y hasta aquí la vuelta'
    case 'result':
      return 'Al salir, enseña el resultado'
    case 'lap':
      return `${title}${brings}`
  }
}

const SPARK = { w: 56, h: 16 }

/** La tira de vueltas: cuántas dio, por cuál va, y (si el bucle lleva una cuenta) cómo fue cambiando. */
function LapStrip({ loop, full, idle }: { loop: Story['loop']; full: boolean; idle: boolean }) {
  const { laps, series } = loop
  const lap = full ? laps : 1
  const values = series?.values ?? []
  const low = Math.min(...values)
  const span = Math.max(...values) - low || 1
  const point = (value: number, at: number) => ({
    x: values.length < 2 ? 0 : (at / (values.length - 1)) * SPARK.w,
    y: SPARK.h - 2 - ((value - low) / span) * (SPARK.h - 4),
  })
  const cursor = Math.min(lap, values.length - 1)
  const here = values.length > 0 ? point(values[cursor] ?? 0, cursor) : null
  return (
    <span className="arch-laps">
      <span className="arch-laps__bar" aria-hidden>
        <span
          className="arch-laps__fill"
          style={{ width: `${(lap / Math.max(1, laps)) * 100}%` }}
        />
      </span>
      <span className="arch-laps__text">
        {idle
          ? `${lapsSaid(loop)} ${laps === 1 ? 'vuelta' : 'vueltas'}`
          : `vuelta ${lap} de ${lapsSaid(loop)}`}
      </span>
      {series && here && (
        <>
          <svg
            className="arch-laps__spark"
            width={SPARK.w}
            height={SPARK.h}
            viewBox={`0 0 ${SPARK.w} ${SPARK.h}`}
            aria-hidden
          >
            <polyline
              points={values
                .map((value, at) => {
                  const { x, y } = point(value, at)
                  return `${x.toFixed(1)},${y.toFixed(1)}`
                })
                .join(' ')}
            />
            <circle cx={here.x} cy={here.y} r={2.6} />
          </svg>
          <span className="arch-laps__value">
            {series.name.replace(/_/g, ' ')}: {values[cursor]}
          </span>
        </>
      )}
    </span>
  )
}

export function Transport({
  beats,
  playback,
  loop,
  titleOf,
  carriesOf,
}: {
  beats: readonly Beat[]
  playback: Playback
  loop: Story['loop']
  /** El nombre, con palabras, del módulo de un paso. */
  titleOf: (id: string) => string
  /** Lo que le llega por una flecha (`desde>hasta`), si lleva nombre. */
  carriesOf: (link: string) => string | undefined
}) {
  const { at, playing } = playback
  const beat = at === null ? undefined : beats[at]
  const said = beat
    ? sayBeat(
        beat,
        titleOf(beat.at),
        beat.links.flatMap((link) => carriesOf(link) ?? []),
        loop,
      )
    : null
  return (
    <div className="canvas-float arch-transport" role="group" aria-label="Ver cómo funciona">
      <button
        type="button"
        className="arch-transport__play"
        aria-label={playing ? 'Pausar' : 'Ver una vuelta'}
        onClick={() => {
          if (playing) playback.pause()
          else playback.play()
        }}
      >
        <span aria-hidden>{playing ? '❚❚' : '▶'}</span>
        {beat ? null : 'Ver una vuelta'}
      </button>
      {beat && (
        <ol className="arch-transport__steps">
          {beats.map((step, index) => (
            <li key={`${step.phase}:${step.at}:${index}`}>
              <button
                type="button"
                className="arch-transport__step"
                data-phase={step.phase}
                data-done={at !== null && index < at ? '' : undefined}
                aria-current={index === at ? 'step' : undefined}
                aria-label={sayBeat(step, titleOf(step.at), [], loop)}
                title={sayBeat(step, titleOf(step.at), [], loop)}
                onClick={() => {
                  playback.go(index)
                }}
              />
            </li>
          ))}
        </ol>
      )}
      {said && (
        <span className="arch-transport__now" aria-live="polite">
          {said}
        </span>
      )}
      <LapStrip
        loop={loop}
        full={beat?.phase === 'again' || beat?.phase === 'result'}
        idle={beat === undefined}
      />
    </div>
  )
}
