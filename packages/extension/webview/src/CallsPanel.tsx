import { useState } from 'react'
import type { CallEntry } from '../../src/calls.ts'

/**
 * La pestaña «Consultas»: todo lo que Prysel le ha preguntado a un modelo y lo que contestó. A la IA
 * generativa (la que redacta) se le ven sus instrucciones, la petición y el texto que devolvió, según
 * llega; al JEV (el que decide), el estado, cada pregunta con sus opciones y cada respuesta con su certeza.
 * Sirve para entender por qué se hizo lo que se hizo, y para ver qué sale del equipo.
 */
export interface CallsPanelProps {
  calls: readonly CallEntry[]
  onClear: () => void
}

const KIND = { ia: 'IA', jev: 'JEV' } as const

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** De qué va una consulta, en una línea: la orden que la provocó, o su primera pregunta. */
function gist(call: CallEntry): string {
  if (call.kind === 'ia') {
    const order = /^(?:Orden|Frase|Lo que dijo el usuario): (.*)$/m.exec(call.prompt ?? '')?.[1]
    return order ?? (call.prompt ?? '').split('\n')[0] ?? ''
  }
  const state = call.state as { orden?: unknown } | undefined
  const order = typeof state?.orden === 'string' ? state.orden : ''
  const asked = (call.questions ?? []).map((question) => question.id).join(', ')
  return order ? `${order} — ${asked}` : asked
}

const pretty = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <section className="calls__block">
      <h4 className="calls__label">{title}</h4>
      <pre className="calls__text">{text}</pre>
    </section>
  )
}

function Detail({ call }: { call: CallEntry }) {
  if (call.kind === 'ia') {
    return (
      <div className="calls__detail">
        <div className="calls__side">
          <h3 className="calls__heading">Consulta</h3>
          <Block title="Instrucciones" text={call.system ?? ''} />
          <Block title="Petición" text={call.prompt ?? ''} />
        </div>
        <div className="calls__side">
          <h3 className="calls__heading">Respuesta</h3>
          <Block
            title={call.status === 'running' ? 'Llegando…' : 'Texto'}
            text={call.text ?? (call.status === 'running' ? '…' : '(nada)')}
          />
          {call.error && <p className="calls__error">{call.error}</p>}
        </div>
      </div>
    )
  }
  const answers = new Map((call.answers ?? []).map((answer) => [answer.id, answer]))
  return (
    <div className="calls__detail">
      <div className="calls__side">
        <h3 className="calls__heading">Consulta</h3>
        <Block title="Estado" text={pretty(call.state)} />
      </div>
      <div className="calls__side">
        <h3 className="calls__heading">Preguntas y respuestas</h3>
        <table className="calls__table">
          <thead>
            <tr>
              <th>Pregunta</th>
              <th>Respuesta</th>
              <th>Certeza</th>
            </tr>
          </thead>
          <tbody>
            {(call.questions ?? []).map((question) => {
              const answer = answers.get(question.id)
              return (
                <tr key={question.id}>
                  <td>
                    <strong>{question.id}</strong>
                    <span className="calls__ask">{question.instructions}</span>
                    {question.options && (
                      <span className="calls__options">
                        {question.options.length > 14
                          ? `${question.options.slice(0, 14).join(' · ')} · … (${question.options.length})`
                          : question.options.join(' · ')}
                      </span>
                    )}
                  </td>
                  <td className="calls__answer">{answer ? answer.answer : '—'}</td>
                  <td className="calls__sure">
                    {answer ? `${Math.round(answer.confidence * 100)} %` : ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {call.error && <p className="calls__error">{call.error}</p>}
      </div>
    </div>
  )
}

export function CallsPanel({ calls, onClear }: CallsPanelProps) {
  const [open, setOpen] = useState<number | null>(null)
  const [only, setOnly] = useState<'all' | 'ia' | 'jev'>('all')
  // Lo último, arriba: es lo que se acaba de pedir.
  const shown = calls.filter((call) => only === 'all' || call.kind === only).reverse()
  const count = (kind: 'ia' | 'jev') => calls.filter((call) => call.kind === kind).length
  return (
    <div className="calls" role="tabpanel" aria-label="Consultas a los modelos">
      <header className="calls__bar">
        <div role="group" aria-label="Qué consultas se ven" className="segmented">
          {(
            [
              ['all', `Todas ${calls.length}`],
              ['ia', `IA ${count('ia')}`],
              ['jev', `JEV ${count('jev')}`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="segmented__item"
              aria-pressed={only === id}
              onClick={() => {
                setOnly(id)
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="calls__hint">
          Lo que se le manda a cada modelo y lo que contesta. Las claves nunca aparecen aquí.
        </span>
        <button
          type="button"
          className="btn"
          data-variant="ghost"
          disabled={calls.length === 0}
          onClick={() => {
            setOpen(null)
            onClear()
          }}
        >
          Vaciar
        </button>
      </header>
      {shown.length === 0 ? (
        <p className="calls__empty">
          Aún no hay consultas. Escribe una orden en el diagrama y aquí verás qué se le pregunta a
          la IA y al JEV, y qué responden.
        </p>
      ) : (
        <ol className="calls__list">
          {shown.map((call) => (
            <li key={call.id} className="calls__item" data-open={open === call.id ? '' : undefined}>
              <button
                type="button"
                className="calls__row"
                aria-expanded={open === call.id}
                onClick={() => {
                  setOpen(open === call.id ? null : call.id)
                }}
              >
                <span className="calls__time">{clock(call.at)}</span>
                <span className="calls__kind" data-kind={call.kind}>
                  {KIND[call.kind]}
                </span>
                <span className="calls__model">{call.model}</span>
                <span className="calls__gist">{gist(call)}</span>
                <span className="calls__status" data-status={call.status}>
                  {call.status === 'running'
                    ? 'en marcha…'
                    : call.status === 'failed'
                      ? 'falló'
                      : `${call.ms ?? 0} ms`}
                </span>
              </button>
              {open === call.id && <Detail call={call} />}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
