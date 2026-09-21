import type { Program } from '@prysel/python'
import { plainNote } from '@prysel/ui'
import { describeEvent, variablesAt } from './player.ts'
import { SPEEDS, type Player } from './usePlayer.ts'

/**
 * La barra de reproducción de un programa: los botones y la línea de tiempo, qué acaba de pasar, cómo
 * están las variables y lo que se imprimió. El diagrama lo enseña el lienzo (el cursor y los chips);
 * esto es el mando.
 */

const button =
  'px-2 py-1 text-[12px] text-ink-muted hover:text-ink disabled:opacity-40 disabled:hover:text-ink-muted'

export function PlayerBar({
  program,
  player,
  truncated,
  failure,
  lesson,
  onClose,
}: {
  program: Program
  player: Player
  /** La traza se cortó por ser demasiado larga. */
  truncated: boolean
  /** El error con el que acabó el programa, si acabó mal. */
  failure: { name: string; message: string } | null
  /** La lección que se está siguiendo: sus momentos en orden de ejecución y cuántos no se alcanzan. */
  lesson?: {
    title: string
    moments: { step: number; title?: string; text: string }[]
    unreached: number
  }
  onClose: () => void
}) {
  const { state, step, last } = player
  const atStart = step < 0
  const atEnd = step >= last
  const variables = state ? variablesAt(state) : []
  const stack = state ? state.frames.filter((frame) => frame.fn !== null) : []
  const moments = lesson?.moments ?? []
  const here = moments.findLastIndex((moment) => moment.step <= step)
  const before = moments.findLast((moment) => moment.step < step)
  const after = moments.find((moment) => moment.step > step)
  const moment = here >= 0 ? moments[here] : undefined
  return (
    <section
      aria-label="Reproducción paso a paso"
      className="border-t border-border-card bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div
          role="group"
          aria-label="Controles"
          className="flex overflow-hidden rounded-md border border-border-card"
        >
          <button
            type="button"
            className={button}
            disabled={atStart}
            aria-label="Al principio"
            onClick={() => {
              player.seek(-1)
            }}
          >
            ⏮
          </button>
          <button
            type="button"
            className={button}
            disabled={atStart}
            aria-label="Paso atrás"
            title="Paso atrás (←)"
            onClick={player.previous}
          >
            ◀
          </button>
          <button
            type="button"
            className={button}
            aria-label={player.playing ? 'Pausar' : 'Reproducir'}
            title="Reproducir o pausar (Espacio)"
            onClick={player.toggle}
          >
            {player.playing ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            className={button}
            disabled={atEnd}
            aria-label="Paso adelante"
            title="Paso adelante (→)"
            onClick={player.next}
          >
            ▶︎|
          </button>
          <button
            type="button"
            className={button}
            disabled={atEnd}
            aria-label="Al final"
            onClick={() => {
              player.seek(last)
            }}
          >
            ⏭
          </button>
        </div>
        {lesson && moments.length > 0 && (
          <div
            role="group"
            aria-label="Momentos de la lección"
            className="flex items-center overflow-hidden rounded-md border border-border-card"
          >
            <button
              type="button"
              className={button}
              disabled={before === undefined && step < 0}
              onClick={() => {
                player.seek(before?.step ?? -1)
              }}
            >
              ‹ Momento
            </button>
            <span className="px-1 text-[11px] tabular-nums text-ink-faint">
              {here + 1} / {moments.length}
            </span>
            <button
              type="button"
              className={button}
              disabled={after === undefined}
              onClick={() => {
                if (after) player.seek(after.step)
              }}
            >
              Momento ›
            </button>
          </div>
        )}
        <input
          type="range"
          min={-1}
          max={last}
          value={step}
          aria-label="Paso de la ejecución"
          className="min-w-24 flex-1 accent-[var(--accent)]"
          onChange={(event) => {
            player.seek(Number(event.target.value))
          }}
        />
        <span className="text-[11px] tabular-nums text-ink-faint" aria-live="off">
          {Math.max(step + 1, 0)} / {last + 1}
        </span>
        <label className="flex items-center gap-1 text-[11px] text-ink-faint">
          Velocidad
          <select
            value={player.speed}
            className="rounded border border-border-card bg-surface px-1 py-0.5 text-[11px] text-ink-muted"
            onChange={(event) => {
              player.setSpeed(Number(event.target.value))
            }}
          >
            {SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="rounded-md border border-border-card px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
          onClick={onClose}
        >
          Salir
        </button>
      </div>

      {lesson && moment && (
        <p className="player__caption" aria-live="polite">
          {moment.title && <strong>{moment.title}. </strong>}
          {plainNote(moment.text)}
        </p>
      )}
      <p className="mt-1.5 text-[12px] text-ink" aria-live="polite">
        <span className="type-code">{state ? describeEvent(program, state) : ''}</span>
        {state?.event && <span className="ml-2 text-ink-faint">línea {state.event.l}</span>}
      </p>
      {state?.error && (
        <p role="alert" className="mt-0.5 text-[12px] text-[var(--chip-error-fg)]">
          {state.error}
        </p>
      )}

      {(variables.length > 0 || stack.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5" aria-label="Variables">
          {stack.length > 0 && (
            <span className="text-[11px] text-ink-faint" title="Las llamadas que están abiertas">
              {stack.map((frame) => frame.fn).join(' › ')}
            </span>
          )}
          {variables.map((variable) => (
            <span
              key={variable.name}
              className={`type-code rounded border px-1.5 py-0.5 text-[11px] ${
                variable.changed
                  ? 'border-[var(--accent)] text-ink'
                  : 'border-border-card text-ink-muted'
              }`}
            >
              {variable.name} = {variable.text}
            </span>
          ))}
        </div>
      )}

      {state && state.output !== '' && (
        <pre className="type-code mt-1.5 max-h-20 overflow-auto rounded border border-border-card px-2 py-1 text-[11px] text-ink-muted">
          {state.output}
        </pre>
      )}

      {lesson && lesson.unreached > 0 && (
        <p className="mt-1 text-[11px] text-ink-faint">
          {lesson.unreached === 1
            ? 'Hay una nota de la lección que el programa no alcanza.'
            : `Hay ${lesson.unreached} notas de la lección que el programa no alcanza.`}
        </p>
      )}

      {atEnd && (truncated || failure) && (
        <p className="mt-1 text-[11px] text-ink-faint">
          {truncated
            ? 'La traza se cortó: el programa hace más pasos de los que se graban.'
            : failure
              ? `El programa acabó con ${failure.name}: ${failure.message}`
              : ''}
        </p>
      )}
    </section>
  )
}
