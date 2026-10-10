import { useEffect, useRef, useState } from 'react'
import type { RunSummary } from '../../src/gist/gist.ts'

/**
 * «Al ejecutarlo»: lo que el programa saca por pantalla, a la vista mientras se construye. Es lo primero que
 * quiere ver quien lo está haciendo: que funciona, y qué hace. Si el programa pide datos por teclado, se ve
 * una sesión de ejemplo: lo que pregunta y, resaltado, lo que se le contestó.
 *
 * Y se puede jugar: quien lo usa escribe sus propias respuestas, una a una, como en una consola. Cada una
 * vuelve a ejecutar el programa con todas las que lleva dadas, y se para en la siguiente pregunta.
 *
 * No interpreta nada: enseña como texto lo que salió y cómo acabó.
 */

/** Cuántas líneas se enseñan: las últimas, que son las que acaban de salir. */
const MAX_LINES = 14

export interface RunLine {
  text: string
  /** Lo que se tecleó al final de esta línea (una respuesta de ejemplo). */
  typed?: string
}

/**
 * Las líneas de la salida, con lo tecleado separado de lo que el programa escribió. Las respuestas salen en
 * orden, cada una al final de la línea en la que se pidió.
 */
export function runLines(output: string, typed: readonly string[] = []): RunLine[] {
  const rows = output.replace(/\n$/, '').split('\n')
  let next = 0
  return rows.map((row) => {
    const answer = typed[next]
    if (answer !== undefined && row.endsWith(answer) && row.length > answer.length) {
      next++
      return { text: row.slice(0, row.length - answer.length), typed: answer }
    }
    // Una pregunta sin texto: la línea es solo la respuesta.
    if (answer !== undefined && row === answer) {
      next++
      return { text: '', typed: answer }
    }
    return { text: row }
  })
}

const ENDED: Record<RunSummary['ended'], string> = {
  done: 'Terminó bien',
  waiting: 'Se quedó esperando otra respuesta',
  cut: 'Era muy largo: se cortó aquí',
  error: 'Falló',
  blocked: 'No se ejecuta solo',
}

export interface RunPanelProps {
  run: RunSummary
  /** Pinchar una línea de la salida: a qué línea del programa lleva (el paso que la escribió). */
  onPick?: ((line: number) => void) | undefined
  /** Lo seleccionado en el diagrama, como líneas del programa: lo que escribió se resalta en la salida. */
  lit?: { from: number; to: number } | undefined
  /**
   * Jugar el programa: todas las respuestas dadas hasta ahora, en orden (`null`: volver al ejemplo; `fresh`:
   * empezar otra partida). Sin esto, la consola solo enseña.
   */
  onPlay?: ((answers: string[] | null, fresh?: boolean) => void) | undefined
}

export function RunPanel({ run, onPick, lit, onPlay }: RunPanelProps) {
  const [open, setOpen] = useState(true)
  const [answer, setAnswer] = useState('')
  /** La salida con la que se mandó la última respuesta: hasta que cambie, se está ejecutando. */
  const [sentFrom, setSentFrom] = useState<RunSummary | null>(null)
  const sending = sentFrom === run
  const field = useRef<HTMLInputElement>(null)
  const playable = onPlay !== undefined && run.asks === true
  const asking = playable && run.ended === 'waiting'
  // Jugando, el cursor se queda en la consola: tras cada respuesta, lista para la siguiente.
  useEffect(() => {
    if (run.mine && asking) field.current?.focus()
  }, [run, asking])
  const play = (answers: string[] | null, fresh = false) => {
    setSentFrom(run)
    setAnswer('')
    onPlay?.(answers, fresh)
  }
  const all = run.output === '' ? [] : runLines(run.output, run.typed)
  const from = Math.max(0, all.length - MAX_LINES)
  const lines = all.slice(from)
  const hidden = from
  /** La línea del programa que escribió la línea `index` de las que se enseñan. */
  const sourceOf = (index: number) => run.sources?.[from + index] ?? null
  const isLit = (index: number) => {
    const source = sourceOf(index)
    return lit !== undefined && source !== null && source >= lit.from && source <= lit.to
  }
  return (
    <section className="run-panel" data-ended={run.ended} aria-label="Al ejecutar el programa">
      <header className="run-panel__head">
        <span className="run-panel__dot" aria-hidden />
        <span className="run-panel__title">Al ejecutarlo</span>
        {run.mine && (
          <span className="run-panel__badge" data-mine="">
            tus respuestas
          </span>
        )}
        {!run.mine && run.typed && run.typed.length > 0 && (
          <span
            className="run-panel__badge"
            title="El programa pide datos por teclado: se le dan unas respuestas de ejemplo para verlo funcionar. Lo que sale es lo que de verdad hizo con ellas."
          >
            respuestas de ejemplo
          </span>
        )}
        <button
          type="button"
          className="node__action run-panel__toggle"
          aria-expanded={open}
          aria-label={open ? 'Plegar la salida' : 'Ver la salida'}
          onClick={() => {
            setOpen(!open)
          }}
        >
          {open ? '–' : '+'}
        </button>
      </header>
      {open && (
        <>
          {lines.length > 0 ? (
            // La clave hace que, al cambiar la salida, las líneas vuelvan a entrar una a una.
            <pre
              // (Jugando no: solo entra lo nuevo, que es lo que el programa acaba de contestar.)
              key={run.mine ? 'mine' : run.output}
              className="run-panel__out"
              // Lo último que salió (cómo acabó) es lo que importa: la consola empieza por el final.
              ref={(element) => {
                if (element) element.scrollTop = element.scrollHeight
              }}
            >
              {hidden > 0 && <span className="run-panel__more">… {hidden} líneas antes</span>}
              {lines.map((line, index) => {
                const source = sourceOf(index)
                const body = (
                  <>
                    {line.text === '' && line.typed === undefined ? ' ' : line.text}
                    {line.typed !== undefined && (
                      <kbd className="run-panel__typed">{line.typed}</kbd>
                    )}
                  </>
                )
                // Una línea de la que se sabe el paso que la escribió lleva a él.
                return source !== null && onPick ? (
                  <button
                    key={index}
                    type="button"
                    className="run-panel__line"
                    data-lit={isLit(index) ? '' : undefined}
                    style={{ '--i': run.mine ? 0 : index } as React.CSSProperties}
                    title="Ver en el diagrama el paso que escribió esto"
                    onClick={() => {
                      onPick(source)
                    }}
                  >
                    {body}
                  </button>
                ) : (
                  <span
                    key={index}
                    className="run-panel__line"
                    data-lit={isLit(index) ? '' : undefined}
                    style={{ '--i': run.mine ? 0 : index } as React.CSSProperties}
                  >
                    {body}
                  </span>
                )
              })}
            </pre>
          ) : (
            run.ended !== 'blocked' && <p className="run-panel__empty">No imprime nada.</p>
          )}
          {asking ? (
            // El programa espera un dato: se le contesta aquí, como en una consola.
            <form
              className="run-panel__ask"
              onSubmit={(event) => {
                event.preventDefault()
                if (!sending) play([...(run.typed ?? []), answer])
              }}
            >
              <span className="run-panel__prompt" aria-hidden>
                ›
              </span>
              <input
                ref={field}
                className="run-panel__field"
                value={answer}
                disabled={sending}
                placeholder={run.mine ? 'Tu respuesta…' : 'Contesta tú para seguir…'}
                aria-label="Tu respuesta al programa"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setAnswer(event.target.value)
                }}
              />
              <button type="submit" className="run-panel__send" disabled={sending}>
                ↵
              </button>
            </form>
          ) : (
            <p className="run-panel__end">
              {ENDED[run.ended]}
              {run.problem ? `: ${run.problem}` : ''}
              {run.line !== undefined ? ` (línea ${run.line})` : ''}
            </p>
          )}
          {playable && (
            <div className="run-panel__actions">
              <button
                type="button"
                className="run-panel__play"
                disabled={sending}
                onClick={() => {
                  play([], true)
                }}
              >
                {run.mine ? '↻ Otra partida' : '▶ Jugar yo'}
              </button>
              {run.mine && (
                <button
                  type="button"
                  className="run-panel__play"
                  data-quiet=""
                  disabled={sending}
                  onClick={() => {
                    play(null)
                  }}
                >
                  Ver el ejemplo
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
