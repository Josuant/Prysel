import type { Idea, IdeaStep } from '@prysel/ui'

/**
 * La **idea** del programa: lo que hace, dicho en unas pocas líneas y a un tamaño que se lee en cualquier
 * pantalla. Es la más lejana de las tres distancias (Idea · Partes · Detalle): antes que las cajas y las
 * flechas, qué pasa y en qué orden.
 *
 * No interpreta nada: son los títulos de las etapas (los que llevan en el código), el orden en que se
 * ejecutaron, lo que se pasan, y lo último que salió por pantalla. Cada línea lleva a su parte.
 */

export type { Idea } from '@prysel/ui'

export interface IdeaExtras {
  /** Dónde empieza el trabajo: el módulo que lo arranca y con qué. */
  start: { at: string; label: string } | null
  /** Cuántas vueltas dio lo que se repite, y cómo salió. */
  laps: string | null
  exit: string | null
  /** Lo último que salió por pantalla (`planned`: aún no sale del programa). */
  result: { said: string; lines: readonly string[]; planned: boolean } | null
}

function Step({
  step,
  ordinal,
  live,
  onPick,
}: {
  step: IdeaStep
  ordinal?: number
  live: boolean
  onPick: (id: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        className="idea__step"
        data-live={live ? '' : undefined}
        title="Ver esta parte en el diagrama"
        onClick={() => {
          onPick(step.id)
        }}
      >
        {ordinal !== undefined && (
          <span className="idea__ordinal" aria-hidden>
            {ordinal}
          </span>
        )}
        <span className="idea__text">
          <span className="idea__title">{step.title}</span>
          {step.says && <span className="idea__says">{step.says}</span>}
        </span>
        {step.brings && (
          <span className="idea__brings" title="Lo que recibe">
            {step.brings}
          </span>
        )}
      </button>
    </li>
  )
}

export function IdeaView({
  idea,
  extras,
  live,
  onPick,
  footer = 0,
}: {
  idea: Idea
  extras: IdeaExtras
  /** Al reproducir una vuelta: la parte en la que se está. */
  live: string | null
  onPick: (id: string) => void
  /** Lo que ocupan abajo las barras que flotan (la de ver una vuelta, la consola): el texto acaba antes. */
  footer?: number
}) {
  const { start, result } = extras
  // La parte donde empieza el trabajo se dice la primera, no entre «lo demás».
  const opener = start ? idea.parts.find((step) => step.id === start.at) : undefined
  const parts = opener ? idea.parts.filter((step) => step !== opener) : idea.parts
  const isLive = (step: IdeaStep) => live !== null && (step.id === live || step.also.includes(live))
  const block = (label: string, steps: readonly IdeaStep[], kind: string) =>
    steps.length > 0 && (
      <section className="idea__block" data-kind={kind}>
        <h3 className="idea__label">{label}</h3>
        <ol className="idea__steps">
          {steps.map((step) => (
            <Step key={step.id} step={step} live={isLive(step)} onPick={onPick} />
          ))}
        </ol>
      </section>
    )
  return (
    <div className="idea" role="region" aria-label="La idea del programa">
      <div className="idea__scroll" style={{ bottom: footer }}>
        <div className="idea__flow">
          {start && (
            <section className="idea__block" data-kind="start">
              <h3 className="idea__label">
                <span className="idea__play" aria-hidden>
                  ▶
                </span>
                {start.label}
              </h3>
              {opener && (
                <ol className="idea__steps">
                  <Step step={opener} live={isLive(opener)} onPick={onPick} />
                </ol>
              )}
            </section>
          )}
          {block('Con', idea.uses, 'uses')}
          {block(idea.loop ? 'Una vez, antes' : 'Primero', idea.before, 'before')}
          {idea.loop && (
            <section
              className="idea__block"
              data-kind="loop"
              data-live={live === idea.loop.id ? '' : undefined}
            >
              <h3 className="idea__label">
                <span className="idea__turn" aria-hidden>
                  ↻
                </span>
                Se repite
                {extras.laps && <span className="idea__laps">{extras.laps}</span>}
              </h3>
              <ol className="idea__steps">
                {idea.loop.steps.map((step, at) => (
                  <Step
                    key={step.id}
                    step={step}
                    ordinal={at + 1}
                    live={isLive(step)}
                    onPick={onPick}
                  />
                ))}
              </ol>
              {extras.exit && (
                <p className="idea__exit">
                  <span aria-hidden>⤷</span> {extras.exit}
                </p>
              )}
            </section>
          )}
          {block(idea.loop ? 'Además' : 'Sus partes', parts, 'parts')}
          {result && (
            <section
              className="idea__block"
              data-kind="result"
              data-planned={result.planned ? '' : undefined}
              data-live={live === 'prysel:result' ? '' : undefined}
            >
              <h3 className="idea__label">{result.planned ? 'Daría' : 'Y al final'}</h3>
              <div className="idea__result">
                {result.lines.map((line, at) => (
                  <span key={at}>{line}</span>
                ))}
              </div>
              <p className="idea__said">{result.said}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
