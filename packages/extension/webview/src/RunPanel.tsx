import { useState } from 'react'
import type { RunSummary } from '../../src/gist/gist.ts'

/**
 * «Al ejecutarlo»: lo que el programa saca por pantalla, a la vista mientras se construye. Es lo primero que
 * quiere ver quien lo está haciendo: que funciona, y qué hace. Si el programa pide datos por teclado, se ve
 * una sesión de ejemplo: lo que pregunta y, resaltado, lo que se le contestó.
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
}

export function RunPanel({ run, onPick, lit }: RunPanelProps) {
  const [open, setOpen] = useState(true)
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
        {run.typed && run.typed.length > 0 && (
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
              key={run.output}
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
                    style={{ '--i': index } as React.CSSProperties}
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
                    style={{ '--i': index } as React.CSSProperties}
                  >
                    {body}
                  </span>
                )
              })}
            </pre>
          ) : (
            run.ended !== 'blocked' && <p className="run-panel__empty">No imprime nada.</p>
          )}
          <p className="run-panel__end">
            {ENDED[run.ended]}
            {run.problem ? `: ${run.problem}` : ''}
            {run.line !== undefined ? ` (línea ${run.line})` : ''}
          </p>
        </>
      )}
    </section>
  )
}
