import type { ReactNode } from 'react'
import type { Program } from '@prysel/python'
import { Icon, IconButton, plainNote } from '@prysel/ui'
import { describeEvent, variablesAt } from './player.ts'
import { SPEEDS, type Player } from './usePlayer.ts'

/**
 * La barra de reproducción de un programa: los botones y la línea de tiempo, qué acaba de pasar, cómo
 * están las variables y lo que se imprimió. El diagrama lo enseña el lienzo (el cursor y los chips);
 * esto es el mando.
 */

export function PlayerBar({
  program,
  player,
  truncated,
  failure,
  lesson,
  extras,
  narrate,
  onToggleNarrate,
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
  /** Más controles (los nodos para entender), bajo los botones. */
  extras?: ReactNode
  /** Voz sincronizada: se lee en voz alta la nota del momento actual. Apagada por defecto. */
  narrate?: boolean
  onToggleNarrate?: () => void
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
  /** Dónde cae un paso sobre la línea de tiempo, en tanto por ciento. */
  const at = (index: number) => (last <= 0 ? 0 : (Math.max(index, 0) / last) * 100)
  return (
    <section aria-label="Reproducción paso a paso" className="player">
      <div className="player__bar">
        <div role="group" aria-label="Controles" className="player__controls">
          <IconButton
            icon="undo"
            label="Al principio"
            disabled={atStart}
            onClick={() => {
              player.seek(-1)
            }}
          />
          <IconButton
            icon="chevron"
            className="player__back"
            label="Paso atrás (←)"
            disabled={atStart}
            onClick={player.previous}
          />
          <button
            type="button"
            className="player__play"
            aria-label={player.playing ? 'Pausar' : 'Reproducir'}
            title="Reproducir o pausar (Espacio)"
            onClick={player.toggle}
          >
            {player.playing ? (
              <span className="player__pause" aria-hidden />
            ) : (
              <Icon name="play" size={16} />
            )}
          </button>
          <IconButton
            icon="chevron"
            className="player__forward"
            label="Paso adelante (→)"
            disabled={atEnd}
            onClick={player.next}
          />
          <IconButton
            icon="redo"
            label="Al final"
            disabled={atEnd}
            onClick={() => {
              player.seek(last)
            }}
          />
        </div>

        {/* La línea de tiempo: el progreso con el acento y, encima, un hito por cada momento de la lección. */}
        <div className="player__timeline">
          <input
            type="range"
            min={-1}
            max={last}
            value={step}
            aria-label="Paso de la ejecución"
            className="slider player__range"
            style={{ '--pct': `${at(step)}%` } as React.CSSProperties}
            onChange={(event) => {
              player.seek(Number(event.target.value))
            }}
          />
          {moments.map((m, index) => (
            <button
              key={`${m.step}-${index}`}
              type="button"
              className="player__moment"
              data-passed={m.step <= step ? '' : undefined}
              data-current={index === here ? '' : undefined}
              style={{ left: `${at(m.step)}%` }}
              aria-label={`Ir al momento ${index + 1}${m.title ? `: ${m.title}` : ''}`}
              title={m.title ?? plainNote(m.text).slice(0, 80)}
              onClick={() => {
                player.seek(m.step)
              }}
            />
          ))}
        </div>
        <span className="player__count" aria-live="off">
          {Math.max(step + 1, 0)} <span className="player__of">/ {last + 1}</span>
        </span>

        {lesson && moments.length > 0 && (
          <div role="group" aria-label="Momentos de la lección" className="player__moments">
            <IconButton
              icon="chevron"
              className="player__back"
              label="Momento anterior"
              disabled={before === undefined && step < 0}
              onClick={() => {
                player.seek(before?.step ?? -1)
              }}
            />
            <span className="player__moment-count">
              Momento {here + 1}
              <span className="player__of"> / {moments.length}</span>
            </span>
            <IconButton
              icon="chevron"
              className="player__forward"
              label="Momento siguiente"
              disabled={after === undefined}
              onClick={() => {
                if (after) player.seek(after.step)
              }}
            />
          </div>
        )}

        <div role="group" aria-label="Velocidad" className="segmented player__speed">
          {SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              className="segmented__item"
              aria-pressed={player.speed === speed}
              onClick={() => {
                player.setSpeed(speed)
              }}
            >
              {speed}×
            </button>
          ))}
        </div>
        {lesson && onToggleNarrate && (
          <button
            type="button"
            className="btn player__voice"
            data-variant={narrate ? 'primary' : 'secondary'}
            aria-pressed={narrate ?? false}
            title={
              narrate
                ? 'Se lee en voz alta la nota de cada momento'
                : 'Leer en voz alta la nota de cada momento'
            }
            onClick={onToggleNarrate}
          >
            {narrate ? 'Voz activada' : 'Voz'}
          </button>
        )}
        <IconButton icon="x" label="Salir del paso a paso" onClick={onClose} />
      </div>

      {extras && <div className="player__extras">{extras}</div>}

      {lesson && moment && (
        <p className="player__caption" aria-live="polite">
          {moment.title && <strong>{moment.title}. </strong>}
          {plainNote(moment.text)}
        </p>
      )}
      <p className="player__now" aria-live="polite">
        <span>{state ? describeEvent(program, state) : ''}</span>
        {state?.event && <span className="player__line">línea {state.event.l}</span>}
      </p>
      {state?.error && (
        <p role="alert" className="mt-0.5 text-[12px] text-[var(--chip-error-fg)]">
          {state.error}
        </p>
      )}

      {(variables.length > 0 || stack.length > 0) && (
        <div className="player__vars" aria-label="Variables">
          {stack.length > 0 && (
            <span className="player__stack" title="Las llamadas que están abiertas">
              {stack.map((frame) => frame.fn).join(' › ')}
            </span>
          )}
          {variables.map((variable) => (
            <span
              key={variable.name}
              className="player__var"
              data-changed={variable.changed ? '' : undefined}
            >
              <span className="player__var-name">{variable.name}</span>
              <span className="player__var-eq">=</span>
              <span className="type-code">{variable.text}</span>
            </span>
          ))}
        </div>
      )}

      {state && state.output !== '' && (
        <pre className="type-code player__output">{state.output}</pre>
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
