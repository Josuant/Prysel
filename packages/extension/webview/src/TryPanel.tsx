import { useState } from 'react'
import type { Gist } from '../../src/gist/gist.ts'
import { parseCall, showValue, type Value } from '../../src/gist/value.ts'

/**
 * Probar una función con otros datos: un campo por cada cosa que recibe, con lo que entró la última vez. Al
 * probar, el programa se ejecuta de verdad con esa llamada y la tarjeta de la función enseña lo que pasó: lo
 * que devuelve, lo que imprime, o el error con el que falla.
 *
 * Solo se aceptan valores (números, textos entre comillas, listas…): la llamada no puede hacer nada que el
 * programa no hiciera ya.
 */

/** Un valor se puede volver a escribir tal cual si se guardó entero (sin recortar) y es un literal. */
const whole = (value: Value): boolean => {
  if (value.kind === 'opaque') return false
  if (value.kind === 'atom') return true
  if (value.more) return false
  return value.kind === 'dict'
    ? value.entries.every(([key, item]) => whole(key) && whole(item))
    : value.items.every(whole)
}

/** Los argumentos de una llamada ya escrita, por orden: `f(1, [2, 3])` → `1`, `[2, 3]`. */
export function argsOf(call: string): string[] {
  const open = call.indexOf('(')
  const body = call.slice(open + 1, call.lastIndexOf(')'))
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let at = 0; at < body.length; at++) {
    const char = body[at] ?? ''
    if (quote !== '') {
      if (char === '\\') at++
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) depth--
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, at).trim())
      start = at + 1
    }
  }
  const last = body.slice(start).trim()
  return last === '' ? parts : [...parts, last]
}

/** Con qué empieza cada campo: lo que entró la última vez, si se puede escribir tal cual. */
export function fieldsOf(gist: Gist): { name: string; text: string }[] {
  const sample = gist.sample
  if (!sample) return []
  // Una prueba que no llegó a entrar en la función no dejó sus datos: se sacan de la llamada.
  if (sample.inputs.length === 0 && sample.call) {
    return argsOf(sample.call).map((text, at) => ({ name: `dato ${at + 1}`, text }))
  }
  return sample.inputs.map((input) => ({
    name: input.name,
    text: whole(input.value) ? showValue(input.value) : '',
  }))
}

/** La llamada que prueba la función con esos datos; `null` si alguno no es un valor. */
export function callOf(name: string, texts: readonly string[]): string | null {
  if (texts.some((text) => text.trim() === '')) return null
  const call = `${name}(${texts.map((text) => text.trim()).join(', ')})`
  const read = parseCall(call)
  // Un campo con una coma suelta colaría un dato de más: tiene que haber uno por campo.
  return read?.method === undefined && argsOf(call).length === texts.length
    ? (read?.text ?? null)
    : null
}

export interface TryPanelProps {
  gist: Gist
  /** Probar con esa llamada; `null`: volver a la muestra del programa. */
  onTry: (call: string | null) => void
  onClose: () => void
}

export function TryPanel({ gist, onTry, onClose }: TryPanelProps) {
  const [fields, setFields] = useState(() => fieldsOf(gist))
  const [problem, setProblem] = useState(false)
  return (
    <form
      aria-label={`Probar ${gist.name} con otros datos`}
      onSubmit={(event) => {
        event.preventDefault()
        const call = callOf(
          gist.name,
          fields.map((field) => field.text),
        )
        setProblem(call === null)
        if (call !== null) onTry(call)
      }}
      style={{ display: 'contents' }}
    >
      <div className="try-panel__head">
        <span>
          Probar <code>{gist.name}</code> con otros datos
        </span>
        <button
          type="button"
          className="node__action try-panel__close"
          aria-label="Cerrar"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {fields.map((field, at) => (
        <label key={at} className="try-panel__row">
          <span className="try-panel__name" title={field.name}>
            {field.name}
          </span>
          <input
            className="try-panel__field"
            value={field.text}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- se abre para escribir en él
            autoFocus={at === 0}
            autoComplete="off"
            spellCheck={false}
            placeholder='un valor: 7, "texto", [1, 2, 3]…'
            onChange={(event) => {
              const text = event.target.value
              setProblem(false)
              setFields((all) => all.map((one, index) => (index === at ? { ...one, text } : one)))
            }}
          />
        </label>
      ))}
      {problem ? (
        <p className="try-panel__problem" role="alert">
          Cada dato tiene que ser un valor: un número, un texto entre comillas, True, False, None, o
          una lista o diccionario de ellos.
        </p>
      ) : (
        <p className="try-panel__hint">
          Se ejecuta de verdad: la tarjeta enseña lo que la función hace con estos datos.
        </p>
      )}
      <div className="try-panel__actions">
        <button type="submit" className="run-panel__play">
          ▶ Probar
        </button>
        {gist.sample?.tried && (
          <button
            type="button"
            className="run-panel__play"
            data-quiet=""
            onClick={() => {
              onTry(null)
            }}
          >
            Volver a la muestra
          </button>
        )}
      </div>
    </form>
  )
}
