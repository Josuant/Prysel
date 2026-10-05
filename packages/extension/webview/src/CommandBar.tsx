import { useState } from 'react'
import { Icon } from '@prysel/ui'
import type { Forced } from '../../src/jev/engine.ts'
import { MAX_COMMAND } from '../../src/protocol.ts'
import { BUDGET_MS, evidenceLine, formatMs, withinBudget, type OrderState } from './orders.ts'

/**
 * La caja de órdenes: se escribe (o se dicta, con el dictado del sistema: Win+H) lo que se quiere, y el
 * motor JEV decide qué hacer. Debajo queda lo que se hizo, quién lo decidió y cuánto tardó.
 */
export interface CommandBarProps {
  state: OrderState
  /** Decir en voz alta lo que se hace. */
  voice: boolean
  onToggleVoice: () => void
  onSubmit: (text: string) => void
  /** El usuario contestó a una pregunta del motor. */
  onChoose: (force: Forced) => void
  onDismiss: () => void
  /** Guardar la clave de TypeSafe (la pide VS Code). */
  onKey: () => void
  /** Se está escribiendo: la voz calla. */
  onTyping: () => void
  /** Detener lo que se está construyendo paso a paso. */
  onStop: () => void
  /** La IA que redacta y el motor que decide ahora (`null`: falta su clave), y abrir el selector. */
  models: { ai: string | null; jev: string | null } | null
  onPickModel: () => void
}

export function CommandBar({
  state,
  voice,
  onToggleVoice,
  onSubmit,
  onChoose,
  onDismiss,
  onKey,
  onTyping,
  onStop,
  models,
  onPickModel,
}: CommandBarProps) {
  const [text, setText] = useState('')
  const busy = state.phase === 'deciding'
  const within = withinBudget(state)
  return (
    <div className="order-bar" data-phase={state.phase}>
      {state.phase !== 'idle' && (
        <div
          className="order-bar__reply"
          role="status"
          aria-live="polite"
          data-tone={state.phase === 'done' ? state.tone : 'muted'}
        >
          <span className="order-bar__said" title={state.text}>
            «{state.text}»
          </span>
          {state.phase === 'deciding' && <span className="order-bar__say">Decidiendo…</span>}
          {state.phase === 'ask' && (
            <>
              <span className="order-bar__say">{state.question}</span>
              <span className="order-bar__options">
                {state.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className="btn"
                    data-variant="secondary"
                    onClick={() => {
                      onChoose(option.force)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
                <button type="button" className="btn" data-variant="ghost" onClick={onDismiss}>
                  Nada
                </button>
              </span>
            </>
          )}
          {state.phase === 'done' && (
            <>
              <span className="order-bar__say">{state.say}</span>
              {state.note && <span className="order-bar__note">{state.note}</span>}
              {state.building && (
                <button type="button" className="btn" data-variant="secondary" onClick={onStop}>
                  Detener
                </button>
              )}
              {state.needsKey && (
                <button type="button" className="btn" data-variant="secondary" onClick={onKey}>
                  Configurar la clave
                </button>
              )}
              {state.engine && (
                <span
                  className="order-bar__meter"
                  data-within={within === null ? undefined : within ? 'yes' : 'no'}
                  title={[
                    state.evidence && state.evidence.length > 0 ? evidenceLine(state.evidence) : '',
                    `Plazo: ${formatMs(BUDGET_MS)} desde que se manda la orden hasta que el cambio se ve.`,
                  ]
                    .filter(Boolean)
                    .join('\n')}
                >
                  {state.engine}
                  {state.jevMs !== undefined && ` · ${formatMs(state.jevMs)}`}
                  {state.totalMs !== undefined && ` · total ${formatMs(state.totalMs)}`}
                </span>
              )}
            </>
          )}
        </div>
      )}
      <form
        className="order-bar__form"
        onSubmit={(event) => {
          event.preventDefault()
          const order = text.trim()
          if (order === '' || busy) return
          setText('')
          onSubmit(order)
        }}
      >
        <Icon name="sparkles" size={14} />
        <input
          className="order-bar__input"
          type="text"
          value={text}
          maxLength={MAX_COMMAND}
          spellCheck={false}
          autoComplete="off"
          aria-label="Orden para el diagrama"
          placeholder="Escribe una orden, o díctala (Win+H): «añade un bucle dentro de entrenar»"
          onChange={(event) => {
            setText(event.target.value)
            onTyping()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setText('')
              onDismiss()
            }
          }}
        />
        <button
          type="button"
          className="btn order-bar__model"
          data-variant="ghost"
          data-missing={models && (models.ai === null || models.jev === null) ? '' : undefined}
          title={[
            `IA que redacta: ${models?.ai ?? 'ninguna (falta elegirla o su clave)'}`,
            `Motor JEV que decide: ${models?.jev ?? 'ninguno (falta la clave de TypeSafe)'}`,
            'Pulsa para elegir los modelos.',
          ].join('\n')}
          onClick={onPickModel}
        >
          {models?.ai ? models.ai.replace(/^[a-z]+:/, '') : 'Elegir modelo'}
        </button>
        <button
          type="button"
          className="btn order-bar__voice"
          data-variant={voice ? 'secondary' : 'ghost'}
          aria-pressed={voice}
          title={
            voice
              ? 'Se dice en voz alta lo que se hace (pulsa para callar)'
              : 'Decir en voz alta lo que se hace'
          }
          onClick={onToggleVoice}
        >
          {voice ? 'Voz activada' : 'Voz'}
        </button>
      </form>
    </div>
  )
}
