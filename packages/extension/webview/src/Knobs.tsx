import { useState } from 'react'
import { knobMoved, knobText, type Knob } from './knobs.ts'

/**
 * Las perillas del programa, sobre el lienzo: los números con los que se puede jugar (con cuántos empieza,
 * cuántas vueltas da) y el **dado**, que lo vuelve a ejecutar con otra suerte. Plegadas son una pastilla;
 * abiertas, una fila por perilla con su menos, su valor y su más.
 *
 * Mover una perilla cambia ese número en el programa y lo vuelve a ejecutar; el dado no cambia nada: solo
 * tira otra vez.
 */
export function Knobs({
  knobs,
  chance,
  onTurn,
  onRoll,
}: {
  knobs: readonly Knob[]
  /** El programa usa el azar: se puede volver a tirar. */
  chance: boolean
  /** Poner una perilla en otro valor. */
  onTurn: (knob: Knob, text: string) => void
  onRoll: () => void
}) {
  const [open, setOpen] = useState(false)
  if (knobs.length === 0 && !chance) return null
  return (
    <div className="canvas-float knobs" data-open={open ? '' : undefined}>
      <div className="knobs__bar">
        {knobs.length > 0 && (
          <button
            type="button"
            className="knobs__toggle"
            aria-expanded={open}
            title="Los números con los que se puede jugar: cámbialos y mira qué pasa"
            onClick={() => {
              setOpen(!open)
            }}
          >
            Perillas
            <span className="knobs__count">{knobs.length}</span>
          </button>
        )}
        {chance && (
          <button
            type="button"
            className="knobs__roll"
            title="Volver a ejecutarlo con otra suerte: el azar saldrá distinto"
            onClick={onRoll}
          >
            <span aria-hidden>⚄</span> Otra tirada
          </button>
        )}
      </div>
      {open && (
        <ul className="knobs__list">
          {knobs.map((knob) => (
            <li key={`${knob.line}:${knob.start}`} className="knobs__row">
              <span
                className="knobs__name"
                title={
                  knob.from === 'launch'
                    ? `${knob.name}: un dato con el que se arranca (línea ${knob.line})`
                    : `${knob.name}: un número que el programa define (línea ${knob.line})`
                }
              >
                {knob.name.replace(/_+/g, ' ').toLowerCase()}
              </span>
              <button
                type="button"
                className="knobs__step"
                aria-label={`Bajar ${knob.name}`}
                onClick={() => {
                  onTurn(knob, knobText(knob, knobMoved(knob, -1)))
                }}
              >
                −
              </button>
              <input
                className="knobs__value"
                inputMode="decimal"
                aria-label={knob.name}
                // Con otro valor (lo cambió el programa), la caja vuelve a empezar con él.
                key={knob.value}
                defaultValue={knobText(knob, knob.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
                onBlur={(event) => {
                  const typed = Number(event.currentTarget.value.replace(',', '.'))
                  if (event.currentTarget.value.trim() === '' || !Number.isFinite(typed)) {
                    event.currentTarget.value = knobText(knob, knob.value)
                    return
                  }
                  const text = knobText(knob, typed)
                  if (Number(text) !== knob.value) onTurn(knob, text)
                }}
              />
              <button
                type="button"
                className="knobs__step"
                aria-label={`Subir ${knob.name}`}
                onClick={() => {
                  onTurn(knob, knobText(knob, knobMoved(knob, 1)))
                }}
              >
                +
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
