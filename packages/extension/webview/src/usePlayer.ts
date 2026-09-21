import { useCallback, useEffect, useMemo, useState } from 'react'
import { stateAt, type TraceIndex, type TraceState } from '../../src/trace.ts'

/** Cuánto dura un paso a velocidad 1×. */
const STEP_MS = 650
export const SPEEDS = [0.5, 1, 2, 4] as const

export interface Player {
  /** El paso en el que está (−1: antes de empezar). */
  step: number
  /** El último paso de la traza. */
  last: number
  playing: boolean
  speed: number
  /** Cómo está el programa en este paso. */
  state: TraceState | null
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (step: number) => void
  next: () => void
  previous: () => void
  setSpeed: (speed: number) => void
}

interface Position {
  /** La traza a la que pertenece: otra traza empieza de nuevo. */
  of: TraceIndex | null
  step: number
  playing: boolean
  speed: number
}

/** El reproductor de una traza: un paso, si va solo y a qué velocidad. Sin traza, no hace nada. */
export function usePlayer(index: TraceIndex | null, stops?: ReadonlySet<number>): Player {
  const [position, setPosition] = useState<Position>({
    of: null,
    step: -1,
    playing: false,
    speed: 1,
  })
  // Una traza nueva empieza desde el principio, sin que nadie tenga que acordarse de reiniciar.
  const fresh = position.of === index
  const step = fresh ? position.step : -1
  const playing = fresh && position.playing
  const speed = position.speed
  const last = index ? index.trace.events.length - 1 : -1

  const update = useCallback(
    (change: (current: Position) => Partial<Position>) => {
      setPosition((previous) => {
        const current = previous.of === index ? previous : { ...previous, of: index, step: -1 }
        return {
          ...current,
          playing: previous.of === index && previous.playing,
          ...change(current),
        }
      })
    },
    [index],
  )

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      update((current) => {
        if (current.step >= last) return { playing: false }
        const step = current.step + 1
        // En una lección, la reproducción se detiene en cada momento del guion: hay algo que leer.
        return stops?.has(step) ? { step, playing: false } : { step }
      })
    }, STEP_MS / speed)
    return () => {
      clearInterval(timer)
    }
  }, [playing, speed, last, update, stops])

  const state = useMemo(() => (index ? stateAt(index, step) : null), [index, step])
  const clamp = (value: number) => Math.max(-1, Math.min(last, value))
  return {
    step,
    last,
    playing,
    speed,
    state,
    play: () => {
      // Si ya llegó al final, volver a darle es empezar otra vez.
      update((current) => (current.step >= last ? { step: -1, playing: true } : { playing: true }))
    },
    pause: () => {
      update(() => ({ playing: false }))
    },
    toggle: () => {
      update((current) =>
        current.playing
          ? { playing: false }
          : current.step >= last
            ? { step: -1, playing: true }
            : { playing: true },
      )
    },
    seek: (to) => {
      update(() => ({ step: clamp(to), playing: false }))
    },
    next: () => {
      update((current) => ({ step: clamp(current.step + 1), playing: false }))
    },
    previous: () => {
      update((current) => ({ step: clamp(current.step - 1), playing: false }))
    },
    setSpeed: (next) => {
      update(() => ({ speed: next }))
    },
  }
}
